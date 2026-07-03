/**
 * runAcpAgent - headless ACP agent entrypoint
 *
 * Wires up an `AgentSideConnection` over stdio: JSON-RPC is written to
 * `process.stdout` and read from `process.stdin`. This process must never
 * write anything else to stdout, since that would corrupt the JSON-RPC
 * stream consumed by the ACP client on the other end of the pipe.
 */

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { HappyAcpAgent } from './HappyAcpAgent';
import { nodeToWebStreams } from '@/utils/nodeToWebStreams';

export async function runAcpAgent(opts: { credentials: Credentials }): Promise<void> {
  // stdout = JSON-RPC out (writable), stdin = JSON-RPC in (readable)
  const { writable, readable } = nodeToWebStreams(process.stdout, process.stdin);
  const stream = ndJsonStream(writable, readable);
  const connection = new AgentSideConnection((conn) => new HappyAcpAgent(conn, opts.credentials), stream);
  await new Promise<void>((resolve) => {
    connection.signal.addEventListener('abort', () => resolve());
  });
}
