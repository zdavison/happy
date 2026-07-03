import type { SDKMessage } from '@/claude/sdk';
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';

export function sdkMessageToUpdates(msg: SDKMessage): SessionUpdate[] {
  if (msg.type !== 'assistant') return [];
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return [];
  const updates: SessionUpdate[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } } as SessionUpdate);
        break;
      case 'thinking':
        if (block.thinking) updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking } } as SessionUpdate);
        break;
      case 'tool_use':
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          title: `${block.name}`,
          status: 'in_progress',
          rawInput: block.input,
        } as SessionUpdate);
        break;
    }
  }
  return updates;
}

export function resultStopReason(msg: SDKMessage): StopReason | null {
  if (msg.type !== 'result') return null;
  const subtype = (msg as any).subtype;
  if (subtype === 'success') return 'end_turn';
  if (subtype === 'error_max_turns') return 'max_turn_requests';
  return 'end_turn';
}
