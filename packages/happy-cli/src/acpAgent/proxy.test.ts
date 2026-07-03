import { describe, it, expect, vi } from 'vitest';
import { HappyProxyAgent, HappyProxyClient } from './proxy';

describe('HappyProxyAgent forwards down', () => {
  it('forwards prompt to the downstream and fires onPrompt tap', async () => {
    const downstream = { prompt: vi.fn(async () => ({ stopReason: 'end_turn' })) } as any;
    const onPrompt = vi.fn();
    const agent = new HappyProxyAgent(() => downstream, { onPrompt });
    const req = { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } as any;
    const res = await agent.prompt(req);
    expect(downstream.prompt).toHaveBeenCalledWith(req);
    expect(onPrompt).toHaveBeenCalledWith(req);
    expect(res).toEqual({ stopReason: 'end_turn' });
  });
  it('forwards newSession and fires onNewSession tap with the response', async () => {
    const resp = { sessionId: 'd1', modes: { currentModeId: 'default', availableModes: [] } };
    const downstream = { newSession: vi.fn(async () => resp) } as any;
    const onNewSession = vi.fn();
    const agent = new HappyProxyAgent(() => downstream, { onNewSession });
    const req = { cwd: '/x', mcpServers: [] } as any;
    const res = await agent.newSession(req);
    expect(res).toBe(resp);                       // verbatim pass-through (modes preserved)
    expect(onNewSession).toHaveBeenCalledWith(req, resp);
  });
});

describe('HappyProxyClient forwards up', () => {
  it('forwards sessionUpdate to Zed and fires onSessionUpdate tap', async () => {
    const zed = { sessionUpdate: vi.fn(async () => {}) } as any;
    const onSessionUpdate = vi.fn();
    const client = new HappyProxyClient(() => zed, { onSessionUpdate });
    const note = { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as any;
    await client.sessionUpdate(note);
    expect(zed.sessionUpdate).toHaveBeenCalledWith(note);
    expect(onSessionUpdate).toHaveBeenCalledWith(note);
  });
  it('forwards readTextFile up to Zed (fs proxied to the editor)', async () => {
    const zed = { readTextFile: vi.fn(async () => ({ content: 'file' })) } as any;
    const client = new HappyProxyClient(() => zed, {});
    const res = await client.readTextFile!({ sessionId: 's1', path: '/a' } as any);
    expect(zed.readTextFile).toHaveBeenCalled();
    expect(res).toEqual({ content: 'file' });
  });
});
