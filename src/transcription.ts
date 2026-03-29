import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-small.bin');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

/**
 * Transcribe audio using OpenAI Whisper API.
 * Faster and more accurate than local whisper.cpp, especially for French.
 * Cost: ~$0.006/minute of audio.
 */
async function transcribeWithOpenAI(
  audioBuffer: Buffer,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const tmpOgg = path.join(tmpDir, `nanoclaw-voice-${Date.now()}.ogg`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), 'audio.ogg');
    formData.append('model', 'whisper-1');
    formData.append('language', 'fr');

    const t0 = Date.now();
    const response = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData,
      },
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(`[voice] OpenAI API error: ${response.status} ${err}`);
      return null;
    }

    const result = (await response.json()) as { text: string };
    console.log(`[voice] OpenAI API: ${Date.now() - t0}ms`);
    return result.text || null;
  } catch (err) {
    console.error('[voice] OpenAI transcription failed:', err);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpOgg);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Transcribe audio using local whisper.cpp.
 * Fallback when OPENAI_API_KEY is not configured.
 */
async function transcribeWithWhisperCpp(
  audioBuffer: Buffer,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert ogg/opus to 16kHz mono WAV (required by whisper.cpp)
    const t1 = Date.now();
    await execFileAsync(
      'ffmpeg',
      ['-i', tmpOgg, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );
    console.log(`[voice] ffmpeg: ${Date.now() - t1}ms`);

    const t2 = Date.now();
    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );
    console.log(`[voice] whisper.cpp: ${Date.now() - t2}ms`);

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return null;
  } finally {
    for (const f of [tmpOgg, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  try {
    // Dynamic import to avoid issues with test mocks
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');

    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return FALLBACK_MESSAGE;
    }

    const t0 = Date.now();
    console.log(`[voice] Downloaded audio: ${buffer.length} bytes`);

    // Use OpenAI API if configured, otherwise fall back to local whisper.cpp
    const transcript = OPENAI_API_KEY
      ? await transcribeWithOpenAI(buffer)
      : await transcribeWithWhisperCpp(buffer);

    if (!transcript) {
      return FALLBACK_MESSAGE;
    }

    console.log(
      `[voice] Transcribed in ${Date.now() - t0}ms: ${transcript.length} chars`,
    );
    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return FALLBACK_MESSAGE;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
