/**
 * Headless integration test for the ACP agent handshake.
 *
 * Drives `HappyAcpAgent` as a real ACP `Agent` implementation, wired to a
 * `ClientSideConnection` over an in-memory duplex (two crossed
 * `TransformStream`s), exactly mirroring the pairing pattern used by the
 * `@agentclientprotocol/sdk` package's own connection tests
 * (`node_modules/@agentclientprotocol/sdk/dist/acp.test.js`): one
 * `TransformStream` per direction, `ndJsonStream(writable, readable)` on
 * each side, an `AgentSideConnection` on the agent side and a
 * `ClientSideConnection` on the client side.
 *
 * This exercises the actual JSON-RPC/ndjson wire format end-to-end (framing,
 * request/response correlation) without touching a live Claude process or the
 * Happy server: `./engine`'s `startEngine` is mocked out so `newSession` /
 * `prompt` never bootstrap anything real.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { HappyAcpAgent } from './HappyAcpAgent';

// Mock the engine so newSession/prompt don't touch the network or spawn Claude.
vi.mock('./engine', () => ({
  startEngine: vi.fn(async () => ({
    happySessionId: 'happy_test',
    push: vi.fn(),
    setPermissionMode: vi.fn(),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  })),
}));

describe('HappyAcpAgent handshake (in-memory ACP wire)', () => {
  it('responds to initialize with protocolVersion 1', async () => {
    // Two crossed TransformStreams form the full-duplex pipe between the
    // agent and the client, one per direction.
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

    new AgentSideConnection(
      (conn) => new HappyAcpAgent(conn, {} as any),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const client = new ClientSideConnection(
      () => ({} as any),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const res = await client.initialize({ protocolVersion: 1, clientCapabilities: {} } as any);

    expect(res.protocolVersion).toBe(1);
  });
});
