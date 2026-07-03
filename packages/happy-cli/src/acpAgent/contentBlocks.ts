import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PendingAttachment } from '@/utils/MessageQueue2';

export function parsePromptBlocks(blocks: ContentBlock[]): { text: string; attachments: PendingAttachment[] } {
  const textParts: string[] = [];
  const attachments: PendingAttachment[] = [];
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text);
        break;
      case 'image':
      case 'audio':
        if ('data' in block && typeof block.data === 'string') {
          attachments.push({
            data: new Uint8Array(Buffer.from(block.data, 'base64')),
            mimeType: ('mimeType' in block && block.mimeType) || 'application/octet-stream',
            name: 'name' in block && block.name ? String(block.name) : 'attachment',
          });
        }
        break;
      case 'resource_link':
        textParts.push(`@${block.name ?? block.uri}`);
        break;
      case 'resource':
        if ('resource' in block && block.resource && 'text' in block.resource && typeof block.resource.text === 'string') {
          textParts.push(block.resource.text);
        }
        break;
    }
  }
  return { text: textParts.join('\n'), attachments };
}
