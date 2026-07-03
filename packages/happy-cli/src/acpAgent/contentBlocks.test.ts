// contentBlocks.test.ts
import { describe, it, expect } from 'vitest';
import { parsePromptBlocks } from './contentBlocks';

describe('parsePromptBlocks', () => {
  it('joins text blocks with newlines', () => {
    const out = parsePromptBlocks([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ] as any);
    expect(out.text).toBe('hello\nworld');
    expect(out.attachments).toEqual([]);
  });

  it('extracts base64 image blocks as attachments', () => {
    const b64 = Buffer.from([1, 2, 3]).toString('base64');
    const out = parsePromptBlocks([
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: b64 },
    ] as any);
    expect(out.text).toBe('look');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].mimeType).toBe('image/png');
    expect(Array.from(out.attachments[0].data)).toEqual([1, 2, 3]);
  });

  it('renders resource_link as a text mention', () => {
    const out = parsePromptBlocks([
      { type: 'resource_link', uri: 'file:///a/b.ts', name: 'b.ts' },
    ] as any);
    expect(out.text).toContain('b.ts');
  });
});
