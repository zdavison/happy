import { describe, it, expect, vi } from 'vitest';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { HappyAcpAgent } from './HappyAcpAgent';
import type { Engine } from './engine';

// `engine`/`acpSessionId`/`onSdkMessage`/`onEngineClosed` are private on
// HappyAcpAgent; startEngine() needs a live server + credentials to construct
// a real Engine, which is infeasible in a unit test. We inject a fake Engine
// directly via `as any` (mirroring the `as any` SDK-message casts already
// used in sdkMessageToAcp.test.ts) so `prompt`'s queueing/resolution logic
// and the launcher-death safety net can be exercised without a live server.
function makeAgent(connectionOverrides: Partial<AgentSideConnection> = {}) {
  const connection = { sessionUpdate: vi.fn(), ...connectionOverrides } as unknown as AgentSideConnection;
  const credentials = {} as Credentials;
  return new HappyAcpAgent(connection, credentials);
}

function makeFakeEngine(push: Engine['push'], resolvePermission: Engine['resolvePermission'] = () => {}): Engine {
  return {
    happySessionId: 'test-session',
    push,
    setPermissionMode: () => {},
    resolvePermission,
    abort: async () => {},
    dispose: async () => {},
  };
}

describe('HappyAcpAgent.prompt', () => {
  it('throws without an active session', async () => {
    const agent = makeAgent();
    await expect(agent.prompt({ sessionId: 'x', prompt: [] } as any)).rejects.toThrow('no active session');
  });

  it('pushes parsed text to the engine and resolves once onSdkMessage sees a result', async () => {
    const agent = makeAgent();
    const pushed: Array<{ text: string; attachments: unknown }> = [];
    (agent as any).engine = makeFakeEngine((text, attachments) => {
      pushed.push({ text, attachments });
    });
    (agent as any).acpSessionId = 'sess-1';

    const promptPromise = agent.prompt({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'hello' }],
    } as any);

    expect(pushed).toEqual([{ text: 'hello', attachments: [] }]);

    // Simulate the engine driving the turn to completion.
    (agent as any).onSdkMessage({ type: 'result', subtype: 'success' });

    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('resolves outstanding prompts with "cancelled" if the engine closes without a result (launcher death)', async () => {
    const agent = makeAgent();
    // Engine that swallows the push and never reports a result back.
    (agent as any).engine = makeFakeEngine(() => {});
    (agent as any).acpSessionId = 'sess-1';

    const promptPromise = agent.prompt({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'hi' }],
    } as any);

    // Simulate the launcher promise settling abnormally (crash/exit with no `result`).
    (agent as any).onEngineClosed();

    await expect(promptPromise).resolves.toEqual({ stopReason: 'cancelled' });

    // The engine is now marked dead: a subsequent prompt must reject rather
    // than push into the defunct queue and hang forever.
    await expect(agent.prompt({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'again' }],
    } as any)).rejects.toThrow('no active session');
  });
});

describe('HappyAcpAgent.onPermissionRequest', () => {
  it('forwards the request to the editor and resolves via the engine on an "allow" selection', async () => {
    const requestPermission = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    const agent = makeAgent({ requestPermission } as Partial<AgentSideConnection>);
    const resolved: Array<{ id: string; approved: boolean }> = [];
    (agent as any).engine = makeFakeEngine(() => {}, (id: string, approved: boolean) => {
      resolved.push({ id, approved });
    });
    (agent as any).acpSessionId = 'sess-1';

    (agent as any).onPermissionRequest({ id: 'req-1', toolName: 'Bash', input: { command: 'ls' } });

    // Let the requestPermission promise settle.
    await new Promise((r) => setImmediate(r));

    expect(requestPermission).toHaveBeenCalledTimes(1);
    const arg = requestPermission.mock.calls[0][0];
    expect(arg.sessionId).toBe('sess-1');
    expect(arg.toolCall).toMatchObject({ toolCallId: 'req-1', title: 'Bash', status: 'pending' });
    expect(arg.options.map((o: any) => o.optionId)).toEqual(['allow', 'deny']);
    expect(resolved).toEqual([{ id: 'req-1', approved: true }]);
  });

  it('resolves with approved=false on a "deny" selection', async () => {
    const requestPermission = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
    const agent = makeAgent({ requestPermission } as Partial<AgentSideConnection>);
    const resolved: Array<{ id: string; approved: boolean }> = [];
    (agent as any).engine = makeFakeEngine(() => {}, (id: string, approved: boolean) => {
      resolved.push({ id, approved });
    });
    (agent as any).acpSessionId = 'sess-1';

    (agent as any).onPermissionRequest({ id: 'req-2', toolName: 'Write', input: {} });
    await new Promise((r) => setImmediate(r));

    expect(resolved).toEqual([{ id: 'req-2', approved: false }]);
  });

  it('does not resolve when the editor cancels the request', async () => {
    const requestPermission = vi.fn().mockResolvedValue({ outcome: { outcome: 'cancelled' } });
    const agent = makeAgent({ requestPermission } as Partial<AgentSideConnection>);
    const resolved: string[] = [];
    (agent as any).engine = makeFakeEngine(() => {}, (id: string) => resolved.push(id));
    (agent as any).acpSessionId = 'sess-1';

    (agent as any).onPermissionRequest({ id: 'req-3', toolName: 'Bash', input: {} });
    await new Promise((r) => setImmediate(r));

    expect(resolved).toEqual([]);
  });
});
