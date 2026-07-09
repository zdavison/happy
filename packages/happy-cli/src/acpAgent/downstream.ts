/**
 * downstream.ts - Spawn the downstream ACP agent and wire an ACP connection to it.
 *
 * The Happy ACP proxy sits between an ACP-speaking editor (e.g. Zed, talking
 * to us as its "agent" over our own stdio) and a real, user-provided coding
 * agent that itself speaks ACP (the "downstream agent"). This module owns the
 * downstream half: spawn the downstream agent as a child process and build a
 * `ClientSideConnection` over its stdio, so we can act as *its* client the
 * same way an editor would.
 *
 * Mirrors the process spawn + stream wiring in `src/agent/acp/AcpBackend.ts`
 * (`spawn(..., { stdio: ['pipe', 'pipe', 'pipe'] })` and its
 * `nodeToWebStreams(this.process.stdin, this.process.stdout)` call), reusing
 * the shared `nodeToWebStreams` helper rather than re-implementing the
 * Node-stream-to-Web-stream bridge.
 *
 * The `Client` implementation itself is supplied by the caller (Task 6 wires
 * in the proxy client that forwards downstream requests up to the editor).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk';
import { nodeToWebStreams } from '@/utils/nodeToWebStreams';
import { logger } from '@/ui/logger';

export function spawnDownstream(
  cfg: { command: string; args: string[]; cwd: string },
  makeClient: (conn: ClientSideConnection) => Client,
): { connection: ClientSideConnection; dispose(): Promise<void> } {
  const child: ChildProcess = spawn(cfg.command, cfg.args, {
    cwd: cfg.cwd,
    // Use 'pipe' for all stdio: we speak JSON-RPC over stdin/stdout and must
    // never let the downstream agent's own stdout/stderr leak to our stdout,
    // since in `acp-agent` mode our stdout is the upstream Zed JSON-RPC channel.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr?.on('data', (data: Buffer) => {
    logger.debug(`[acpAgent/downstream] stderr: ${data.toString()}`);
  });
  child.on('error', (err) => {
    logger.debug('[acpAgent/downstream] spawn error:', err);
  });

  if (!child.stdin || !child.stdout) {
    throw new Error('[acpAgent/downstream] Failed to create stdio pipes for downstream agent');
  }

  // We WRITE JSON-RPC to the child's stdin and READ it from its stdout.
  const { writable, readable } = nodeToWebStreams(child.stdin, child.stdout);
  const stream = ndJsonStream(writable, readable);

  // The SDK calls this factory synchronously during construction and passes in
  // the connection itself (as `Agent`), so we hand that straight to
  // `makeClient` rather than capturing an outer `let` that wouldn't be assigned
  // yet. Its `Client` methods only run later, once construction is complete.
  const connection: ClientSideConnection = new ClientSideConnection(
    (agent) => makeClient(agent as ClientSideConnection),
    stream,
  );

  return {
    connection,
    dispose: async () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    },
  };
}
