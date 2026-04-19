import { describe, expect, it } from 'vitest';

import { parseImageReferences } from './image.js';

describe('parseImageReferences', () => {
  it('extracts a single attachment from `[Image reçue : …]`', () => {
    const refs = parseImageReferences([
      { content: '[Image reçue : attachments/foo.jpg] @Andy décris' },
    ]);

    expect(refs).toEqual([
      { relativePath: 'attachments/foo.jpg', mediaType: 'image/jpeg' },
    ]);
  });

  it('extracts multiple attachments across messages', () => {
    const refs = parseImageReferences([
      { content: '[Image reçue : attachments/a.jpg]' },
      { content: 'random text' },
      {
        content:
          '[Image reçue : attachments/b.jpg] caption [Image reçue : attachments/c.jpg]',
      },
    ]);

    expect(refs.map((r) => r.relativePath)).toEqual([
      'attachments/a.jpg',
      'attachments/b.jpg',
      'attachments/c.jpg',
    ]);
  });

  it('ignores the legacy `[Image: …]` format (regression guard)', () => {
    const refs = parseImageReferences([
      { content: '[Image: attachments/legacy.jpg]' },
    ]);

    expect(refs).toEqual([]);
  });

  it('returns an empty array when no references exist', () => {
    expect(parseImageReferences([{ content: 'hello world' }])).toEqual([]);
  });
});
