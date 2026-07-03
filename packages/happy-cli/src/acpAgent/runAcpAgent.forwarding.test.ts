/**
 * Hermetic end-to-end forwarding test for the ACP proxy.
 *
 * `runAcpAgent` itself needs a live Happy server (via `PhoneRelay.start`) and a
 * real downstream process (via `spawnDownstream`), so it can't be exercised
 * directly in a unit test. What CAN be exercised hermetically, at full wire
 * fidelity, is the actual three-party ACP topology the proxy assembles:
 *
 *   fake Zed (ClientSideConnection) <--ndjson--> proxy (AgentSideConnection
 *     wrapping HappyProxyAgent) <--in-process--> proxy (ClientSideConnection
 *     wrapping HappyProxyClient) <--ndjson--> fake downstream
 *     (AgentSideConnection wrapping a scripted Agent)
 *
 * This wires up REAL `ClientSideConnection`/`AgentSideConnection` instances
 * from the ACP SDK, piped over real `ndJsonStream`s backed by in-memory
 * `TransformStream`s (so requests/responses are actually JSON-RPC-encoded and
 * decoded, not just passed as JS objects), with `HappyProxyAgent` /
 * `HappyProxyClient` (the exact classes `runAcpAgent` constructs) sitting in
 * the middle unmodified. Only the two ends (the fake Zed and the fake
 * downstream agent) are test doubles. This is a genuine forwarding assertion
 * through the real proxy classes and the real ACP wire protocol -- not a
 * mock-of-a-mock.
 *
 * No import of `./runAcpAgent` or `./phoneRelay` is needed: this test only
 * exercises `HappyProxyAgent` / `HappyProxyClient`, so there's no server
 * dependency to mock.
 *
 * NAMING NOTE: the task brief names this file `*.integration.test.ts`, but
 * this repo's `vitest.config.ts` reserves that suffix for tests that need a
 * live/authenticated setup (`src/**\/*.integration.test.ts` is excluded from
 * the `unit` project, and the three dedicated `integration-*` projects only
 * include an explicit allowlist of filenames elsewhere in the tree -- this
 * file matches none of them). Named that way, this test would silently never
 * run under `npx vitest run src/acpAgent` or the default test command. Since
 * this test is fully hermetic (no network, no live server, no subprocess),
 * it belongs in -- and is named for -- the `unit` project instead.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type PromptRequest,
} from '@agentclientprotocol/sdk';
import { HappyProxyAgent, HappyProxyClient, type ProxyTaps } from './proxy';

/**
 * A full-duplex pair of in-memory byte streams: writes to side A's `writable`
 * arrive on side B's `readable`, and vice versa. Backs `ndJsonStream` the same
 * way a real stdio pipe would, so messages genuinely round-trip through
 * newline-delimited-JSON encode/decode.
 */
function duplexBytePair(): [
  { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> },
  { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> },
] {
  const aToB = new TransformStream<Uint8Array, Uint8Array>();
  const bToA = new TransformStream<Uint8Array, Uint8Array>();
  return [
    { writable: aToB.writable, readable: bToA.readable },
    { writable: bToA.writable, readable: aToB.readable },
  ];
}

describe('ACP proxy forwards over the real wire protocol', () => {
  it('round-trips newSession + prompt down to a fake downstream, and a sessionUpdate back up to fake Zed', async () => {
    // --- Wire: fakeZed <-ndjson-> proxyUpstream, and proxyDownstream <-ndjson-> fakeDownstream ---
    const [zedSideBytes, proxyUpstreamBytes] = duplexBytePair();
    const zedStream = ndJsonStream(zedSideBytes.writable, zedSideBytes.readable);
    const proxyUpstreamStream = ndJsonStream(proxyUpstreamBytes.writable, proxyUpstreamBytes.readable);

    const [proxyDownstreamBytes, fakeDownstreamBytes] = duplexBytePair();
    const proxyDownstreamStream = ndJsonStream(proxyDownstreamBytes.writable, proxyDownstreamBytes.readable);
    const fakeDownstreamStream = ndJsonStream(fakeDownstreamBytes.writable, fakeDownstreamBytes.readable);

    // --- Fake downstream agent: scripted responses, and pushes one sessionUpdate mid-prompt ---
    let downstreamConn!: AgentSideConnection;
    const fakeDownstreamAgent: Agent = {
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      newSession: vi.fn(async () => ({ sessionId: 'd1' })),
      authenticate: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async (params: PromptRequest) => {
        await downstreamConn.sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } },
        } as any);
        return { stopReason: 'end_turn' as const };
      }),
    };
    downstreamConn = new AgentSideConnection(() => fakeDownstreamAgent, fakeDownstreamStream);

    // --- The proxy itself: the exact classes runAcpAgent constructs, unmodified ---
    const taps: ProxyTaps = {
      onNewSession: vi.fn(),
      onPrompt: vi.fn(),
      onSessionUpdate: vi.fn(),
    };
    // Construction ordering mirrors runAcpAgent.ts: `zedConn` is referenced
    // lazily by the proxy client (only dereferenced once a downstream Client
    // call arrives, which is strictly after `zedConn` is assigned below).
    let zedConn!: AgentSideConnection;
    const proxyClient = new HappyProxyClient(() => zedConn, taps);
    const proxyDownstreamConn = new ClientSideConnection(() => proxyClient, proxyDownstreamStream);
    const proxyAgent = new HappyProxyAgent(() => proxyDownstreamConn, taps);
    zedConn = new AgentSideConnection(() => proxyAgent, proxyUpstreamStream);

    // --- Fake Zed: the "editor" driving the proxy from the other side ---
    const fakeZedClient: Client = {
      sessionUpdate: vi.fn(async () => {}),
      requestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' } } as any)),
    };
    const zedClientConn = new ClientSideConnection(() => fakeZedClient, zedStream);

    // --- Exercise: Zed calls newSession, then prompt, through the real proxy ---
    const newSessionRes = await zedClientConn.newSession({ cwd: '/x', mcpServers: [] } as any);
    expect(newSessionRes).toEqual({ sessionId: 'd1' }); // verbatim pass-through of the downstream's response
    expect(taps.onNewSession).toHaveBeenCalledTimes(1);

    const promptRes = await zedClientConn.prompt({
      sessionId: 'd1',
      prompt: [{ type: 'text', text: 'hi' }],
    } as any);
    expect(promptRes).toEqual({ stopReason: 'end_turn' });
    expect(taps.onPrompt).toHaveBeenCalledTimes(1);

    // The downstream's mid-prompt sessionUpdate must have forwarded all the
    // way up through the proxy to fake Zed, and fired the tap.
    expect(fakeDownstreamAgent.prompt).toHaveBeenCalledTimes(1);
    expect(fakeZedClient.sessionUpdate).toHaveBeenCalledTimes(1);
    expect(fakeZedClient.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'd1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } },
      }),
    );
    expect(taps.onSessionUpdate).toHaveBeenCalledTimes(1);
  });
});
