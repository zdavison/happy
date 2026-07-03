/**
 * Tests for sessionUpdateToEnvelopes: the Phase-1 (ACP-tier) phone-tap mapper.
 *
 * NOTE on access path: `SessionEnvelope` (from `@slopus/happy-wire`) nests the
 * mapped session event under the `ev` property (not `content`) — see
 * `packages/happy-wire/src/sessionProtocol.ts`'s `sessionEnvelopeSchema`. The
 * brief's sketch asserted `out[0].content`; the asserted shapes are unchanged,
 * only the access path is corrected to `out[0].ev` here.
 */
import { describe, it, expect } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { sessionUpdateToEnvelopes } from './phoneRelay';

describe('sessionUpdateToEnvelopes', () => {
  it('maps agent_message_chunk text to a text envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as SessionUpdate, 't1');
    expect(out).toHaveLength(1);
    expect(out[0].ev).toMatchObject({ t: 'text', text: 'hi' });
  });

  it('maps agent_thought_chunk to a thinking text envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as SessionUpdate, 't1');
    expect(out[0].ev).toMatchObject({ t: 'text', text: 'hmm', thinking: true });
  });

  it('maps tool_call to a tool-call-start envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', rawInput: { command: 'ls' } } as SessionUpdate, 't1');
    expect(out[0].ev).toMatchObject({ t: 'tool-call-start', call: 'c1' });
  });

  it('maps tool_call_update(completed) to a tool-call-end envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' } as SessionUpdate, 't1');
    expect(out[0].ev).toMatchObject({ t: 'tool-call-end', call: 'c1' });
  });

  it('returns [] for unhandled variants', () => {
    expect(sessionUpdateToEnvelopes({ sessionUpdate: 'plan' } as unknown as SessionUpdate, 't1')).toEqual([]);
  });
});
