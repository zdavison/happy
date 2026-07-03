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
import type { SessionUpdate, RequestPermissionRequest, PermissionOption } from '@agentclientprotocol/sdk';
import { sessionUpdateToEnvelopes, extractPermissionRequestInput, permissionResultToOutcome } from './phoneRelay';

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

describe('extractPermissionRequestInput', () => {
  it('pulls toolCallId/toolName/input from the ACP request', () => {
    const request = {
      options: [],
      sessionId: 's1',
      toolCall: { toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } },
    } as unknown as RequestPermissionRequest;
    expect(extractPermissionRequestInput(request)).toEqual({
      toolCallId: 'c1',
      toolName: 'execute',
      input: { command: 'ls' },
    });
  });

  it('falls back through title and the extended input fields', () => {
    const request = {
      options: [],
      sessionId: 's1',
      toolCall: { toolCallId: 'c2', title: 'Read file', arguments: { path: '/tmp/x' } },
    } as unknown as RequestPermissionRequest;
    const out = extractPermissionRequestInput(request);
    expect(out.toolName).toBe('Read file');
    expect(out.input).toEqual({ path: '/tmp/x' });
  });
});

describe('permissionResultToOutcome', () => {
  const options: PermissionOption[] = [
    { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'yes-always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ];

  it('maps approved to the allow_once option id', () => {
    expect(permissionResultToOutcome({ decision: 'approved' }, options)).toEqual({
      outcome: { outcome: 'selected', optionId: 'yes' },
    });
  });

  it('maps approved_for_session to the allow_always option id', () => {
    expect(permissionResultToOutcome({ decision: 'approved_for_session' }, options)).toEqual({
      outcome: { outcome: 'selected', optionId: 'yes-always' },
    });
  });

  it('maps denied to the reject option id', () => {
    expect(permissionResultToOutcome({ decision: 'denied' }, options)).toEqual({
      outcome: { outcome: 'selected', optionId: 'no' },
    });
  });

  it('maps abort with no reject option to a cancelled outcome', () => {
    const allowOnly: PermissionOption[] = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }];
    expect(permissionResultToOutcome({ decision: 'abort' }, allowOnly)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
