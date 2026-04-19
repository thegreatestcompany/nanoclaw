/**
 * Image processing for WhatsApp vision.
 * Downloads, resizes, and saves images for multimodal Claude processing.
 * Based on NanoClaw upstream add-image-vision skill.
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_DIMENSION = 1024;
// Matches `[Image reçue : attachments/foo.jpg]`. Spaces around `:` mirror the
// `[Document reçu : …]` / `[Vocal reçu : …]` conventions and CLAUDE.md.
const IMAGE_REF_PATTERN = /\[Image reçue : (attachments\/[^\]]+)\]/g;

export interface ProcessedImage {
  content: string;
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, resized);

  const relativePath = `attachments/${filename}`;
  const content = caption
    ? `[Image reçue : ${relativePath}] ${caption}`
    : `[Image reçue : ${relativePath}]`;

  return { content, relativePath };
}

/**
 * Parse image references from message content.
 * Used to extract image paths before passing to the container.
 */
export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      refs.push({ relativePath: match[1], mediaType: 'image/jpeg' });
    }
  }
  return refs;
}
