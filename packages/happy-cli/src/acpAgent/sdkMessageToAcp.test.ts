import { describe, it, expect } from 'vitest';
import { sdkMessageToUpdates, resultStopReason } from './sdkMessageToAcp';

const assistant = (content: any[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
} as any);

const user = (content: any[]) => ({
  type: 'user',
  message: { role: 'user', content },
} as any);

describe('sdkMessageToUpdates', () => {
  it('maps assistant text to agent_message_chunk', () => {
    const [u] = sdkMessageToUpdates(assistant([{ type: 'text', text: 'hi' }]));
    expect(u.sessionUpdate).toBe('agent_message_chunk');
    expect((u as any).content).toEqual({ type: 'text', text: 'hi' });
  });

  it('maps thinking to agent_thought_chunk', () => {
    const [u] = sdkMessageToUpdates(assistant([{ type: 'thinking', thinking: 'hmm' }]));
    expect(u.sessionUpdate).toBe('agent_thought_chunk');
    expect((u as any).content).toEqual({ type: 'text', text: 'hmm' });
  });

  it('maps tool_use to tool_call with id and title', () => {
    const [u] = sdkMessageToUpdates(assistant([
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
    ]));
    expect(u.sessionUpdate).toBe('tool_call');
    expect((u as any).toolCallId).toBe('tu_1');
    expect((u as any).title).toContain('Bash');
  });

  it('maps user tool_result to tool_call_update (completed)', () => {
    const [u] = sdkMessageToUpdates(user([
      { type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: 'ok' },
    ]));
    expect(u.sessionUpdate).toBe('tool_call_update');
    expect((u as any).toolCallId).toBe('tu_1');
    expect((u as any).status).toBe('completed');
  });

  it('maps user tool_result with is_error to tool_call_update (failed)', () => {
    const [u] = sdkMessageToUpdates(user([
      { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'boom' },
    ]));
    expect(u.sessionUpdate).toBe('tool_call_update');
    expect((u as any).toolCallId).toBe('tu_2');
    expect((u as any).status).toBe('failed');
  });

  it('returns [] for result messages', () => {
    expect(sdkMessageToUpdates({ type: 'result', subtype: 'success' } as any)).toEqual([]);
  });
});

describe('resultStopReason', () => {
  it('maps success to end_turn', () => {
    expect(resultStopReason({ type: 'result', subtype: 'success' } as any)).toBe('end_turn');
  });
  it('returns null for non-result', () => {
    expect(resultStopReason({ type: 'assistant', message: { content: [] } } as any)).toBeNull();
  });
});
