/**
 * runAcpAgent - assemble the Happy ACP proxy.
 *
 * Wires three parties together. "Upstream" is the ACP-speaking client that
 * spawned this proxy — any conforming code editor or UI (e.g. Zed, Neovim, a
 * custom app).
 *
 *   upstream client  <--stdio-->  Happy proxy  <--stdio-->  downstream ACP agent
 *                                     |
 *                                     +--> PhoneRelay (Happy server session)
 *
 * The proxy forwards ACP traffic verbatim in both directions (`HappyProxyAgent`
 * carries the upstream client's Agent-side calls down to the downstream
 * `ClientSideConnection`; `HappyProxyClient` carries the downstream's
 * Client-side calls up to the upstream client's `AgentSideConnection`).
 * Alongside the forward path, side-effect-only taps feed the phone: turn
 * start/end and streamed session updates.
 *
 * Three behaviours are layered on at this assembly seam rather than inside the
 * pure forwarders:
 *
 *  1. **3-party permission race** (`proxyClient.requestPermission`): a downstream
 *     permission request is fanned out to BOTH the upstream client and the
 *     phone; the first successful answer wins (see the override for the loser
 *     cancellation semantics).
 *
 *  2. **Terminal capability strip** (`stripTerminal` on `proxyAgent.initialize`):
 *     the proxy's `HappyProxyClient` does NOT implement the terminal lifecycle
 *     ops (output/wait/kill/release), and unimplemented Client methods return
 *     `undefined` rather than erroring. So when forwarding the upstream client's
 *     `initialize` down we must NOT advertise terminal support to the
 *     downstream. `fs` capabilities are kept (readTextFile/writeTextFile ARE
 *     forwarded).
 *
 *  3. **One turn in flight** (`serializedPrompt`, wrapping `spawned.connection.prompt`):
 *     the upstream client and the phone can each independently send a prompt to
 *     the downstream with no coordination between them. Both `proxyAgent.prompt`
 *     (upstream) and `relay.onUserMessage` (phone) are routed through a single
 *     `createPromptSerializer` instance so the downstream never receives two
 *     concurrent `prompt` calls -- the next one starts only once the previous
 *     has settled.
 */
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { InitializeRequest, PromptRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { nodeToWebStreams } from '@/utils/nodeToWebStreams';
import { HappyProxyAgent, HappyProxyClient, type ProxyTaps } from './proxy';
import { spawnDownstream } from './downstream';
import { PhoneRelay } from './phoneRelay';
import { createPromptSerializer } from './promptSerializer';
import { raceFirstSuccessful } from './raceFirstSuccessful';
import { logger } from '@/ui/logger';

/**
 * Deep-clone an `InitializeRequest` and strip the client's `terminal`
 * capability so the downstream is never told Happy supports terminals. `fs`
 * (and everything else) is preserved. Pure — exported for tests.
 */
export function stripTerminal(req: InitializeRequest): InitializeRequest {
  const clone = structuredClone(req);
  if (clone.clientCapabilities) {
    delete clone.clientCapabilities.terminal;
  }
  return clone;
}

export async function runAcpAgent(opts: {
  credentials: Credentials;
  agentName: string;
  command: string;
  args: string[];
}): Promise<void> {
  const relay = await PhoneRelay.start({ credentials: opts.credentials, agentName: opts.agentName });

  // Downstream sessionId captured at newSession, used to route phone-driven
  // prompts to the same session the upstream client established.
  let currentDownstreamSessionId: string | null = null;

  // The SDK connections form a reference cycle
  // (upstream → proxyAgent → downstream → proxyClient → upstream). `upstream`
  // is the single link that must be assigned last; the getters that read it are
  // only invoked once a downstream message arrives, well after assignment.
  let upstream!: AgentSideConnection;

  const taps: ProxyTaps = {
    onNewSession: (_req, res) => {
      currentDownstreamSessionId = res.sessionId;
      relay.startTurn();
    },
    onPrompt: () => relay.startTurn(),
    onSessionUpdate: (note) => relay.pushUpdate(note),
    // Turn-end is driven explicitly from the `prompt` overrides below (in a
    // finally), so a failed downstream turn still closes the phone turn.
  };

  const proxyClient = new HappyProxyClient(() => upstream, taps);

  // 3-party permission race, first-successful-answer wins: the downstream's
  // permission request is fanned out to BOTH the upstream client and the phone.
  // If the upstream answers first, the still-pending phone prompt is cancelled
  // via `onLose`. Cancelling the upstream client's native prompt when the phone
  // wins isn't exposed by the ACP SDK, so that leg simply settles when the user
  // dismisses it.
  proxyClient.requestPermission = (params) =>
    raceFirstSuccessful<RequestPermissionResponse>([
      { run: upstream.requestPermission(params) },
      {
        run: relay.requestPermission(params),
        onLose: () => relay.cancelPermission(params, 'Answered in the editor/UI'),
      },
    ]);

  const spawned = spawnDownstream(
    { command: opts.command, args: opts.args, cwd: process.cwd() },
    () => proxyClient,
  );

  const proxyAgent = new HappyProxyAgent(() => spawned.connection, taps);

  // Strip the `terminal` capability from the forwarded `initialize` (see
  // stripTerminal / the file header). Everything else forwards verbatim.
  proxyAgent.initialize = (params) => spawned.connection.initialize(stripTerminal(params));

  // One turn in flight, regardless of source: the upstream client and the phone
  // can each independently decide to send a prompt to the downstream (see the
  // file header), and downstream agents may reject or misbehave on a second
  // concurrent `prompt` call. Route every downstream prompt -- from either
  // side -- through a single serializer so the next prompt never starts until
  // the previous one has settled.
  const serializedPrompt = createPromptSerializer((p: PromptRequest) => spawned.connection.prompt(p));

  // Route the upstream client's prompts through the serializer. `onPrompt` opens
  // the phone turn before forwarding; `endTurn` runs in a finally so the turn is
  // closed on both success and downstream failure (a rejected turn reports
  // 'failed').
  proxyAgent.prompt = async (p) => {
    taps.onPrompt?.(p);
    let status: 'completed' | 'failed' = 'completed';
    try {
      return await serializedPrompt(p);
    } catch (error) {
      status = 'failed';
      throw error;
    } finally {
      relay.endTurn(status);
    }
  };

  const { writable, readable } = nodeToWebStreams(process.stdout, process.stdin);
  upstream = new AgentSideConnection(() => proxyAgent, ndJsonStream(writable, readable));

  // Phone drives: a phone message becomes a prompt to the downstream, routed to
  // the session the upstream client established. Same sink as its own prompts.
  relay.onUserMessage((text) => {
    if (!currentDownstreamSessionId) {
      return;
    }
    void serializedPrompt({ sessionId: currentDownstreamSessionId, prompt: [{ type: 'text', text }] })
      .then(() => relay.endTurn('completed'))
      .catch((e) => {
        logger.debug('[acp-agent] phone prompt failed', e);
        relay.endTurn('failed');
      });
  });

  // Stay alive until the upstream client's connection closes, then tear down.
  await new Promise<void>((resolve) => {
    upstream.signal.addEventListener('abort', () => resolve());
  });
  await spawned.dispose();
  await relay.dispose();
}
