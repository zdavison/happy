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
function makeAgent() {
  const connection = { sessionUpdate: vi.fn() } as unknown as AgentSideConnection;
  const credentials = {} as Credentials;
  return new HappyAcpAgent(connection, credentials);
}

function makeFakeEngine(push: Engine['push']): Engine {
  return {
    happySessionId: 'test-session',
    push,
    setPermissionMode: () => {},
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
  });
});
