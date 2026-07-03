/**
 * runAcpAgent - assemble the Happy ACP proxy.
 *
 * Wires three parties together:
 *
 *   Zed (editor)  <--stdio-->  Happy proxy  <--stdio-->  downstream ACP agent
 *                                   |
 *                                   +--> PhoneRelay (Happy server session)
 *
 * The proxy forwards ACP traffic verbatim in both directions (`HappyProxyAgent`
 * carries Zed's Agent-side calls down to the downstream `ClientSideConnection`;
 * `HappyProxyClient` carries the downstream's Client-side calls up to Zed's
 * `AgentSideConnection`). Alongside the forward path, side-effect-only taps feed
 * the phone: turn start/end and streamed session updates.
 *
 * Two behaviours are layered on at this assembly seam rather than inside the
 * pure forwarders:
 *
 *  1. **3-party permission race** (`proxyClient.requestPermission`): a downstream
 *     permission request is fanned out to BOTH Zed and the phone; the first
 *     successful answer wins. The loser's request is left outstanding
 *     (accepted Phase-1 leak — see comment at the override).
 *
 *  2. **Terminal capability strip** (`stripTerminal` on `proxyAgent.initialize`):
 *     the proxy's `HappyProxyClient` does NOT implement the terminal lifecycle
 *     ops (output/wait/kill/release), and unimplemented Client methods return
 *     `undefined` rather than erroring. So when forwarding Zed's `initialize`
 *     down we must NOT advertise terminal support to the downstream. `fs`
 *     capabilities are kept (readTextFile/writeTextFile ARE forwarded).
 */
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { InitializeRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { nodeToWebStreams } from '@/utils/nodeToWebStreams';
import { HappyProxyAgent, HappyProxyClient, type ProxyTaps } from './proxy';
import { spawnDownstream } from './downstream';
import { PhoneRelay } from './phoneRelay';
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
  // prompts to the same session Zed established.
  let currentDownstreamSessionId: string | null = null;

  // `zed` is constructed last but referenced by the (lazy) getter passed to
  // `HappyProxyClient` below. The getter is only invoked once a message
  // arrives, which is strictly after `zed` is assigned — so the non-null
  // assertion is safe. See the construction-ordering note further down.
  let zed!: AgentSideConnection;

  const taps: ProxyTaps = {
    onNewSession: (_req, res) => {
      currentDownstreamSessionId = res.sessionId;
      relay.startTurn();
    },
    onPrompt: () => relay.startTurn(),
    onSessionUpdate: (note) => relay.pushUpdate(note),
    // A Zed-initiated prompt turn ends when the downstream `prompt` call
    // resolves; `HappyProxyAgent.prompt` fires this after forwarding. This is
    // the one cleanly-detectable turn-end signal, so we drive `endTurn` here
    // rather than trying to infer it from the update stream.
    onPromptDone: () => relay.endTurn('completed'),
  };

  // --- Construction ordering (mutual references are all lazy getters) ---------
  // 1. proxyClient  (references `zed` lazily via `() => zed`)
  // 2. spawnDownstream  (assigns `spawned.connection`; ClientSideConnection's
  //    ctor calls makeClient SYNCHRONOUSLY, handing back proxyClient — which
  //    only dereferences `zed` later, when a downstream Client call arrives)
  // 3. proxyAgent  (references `spawned.connection` lazily via `() => ...`)
  // 4. zed = new AgentSideConnection(() => proxyAgent, ...)  (factory called
  //    SYNCHRONOUSLY, but proxyAgent already exists by now)

  const proxyClient = new HappyProxyClient(() => zed, taps);

  // 3-party permission race, first-answer-wins. Forward the downstream's
  // permission request to BOTH Zed and the phone and return whichever answers
  // first. A rejected leg must NOT win the race, so each leg is guarded to
  // never resolve on rejection (it hangs instead). The losing leg's request is
  // left outstanding — an accepted Phase-1 leak (no cross-cancel of the loser).
  proxyClient.requestPermission = (params) => {
    const zedLeg = zed
      .requestPermission(params)
      .catch(() => new Promise<RequestPermissionResponse>(() => {}));
    const phoneLeg = relay
      .requestPermission(params)
      .catch(() => new Promise<RequestPermissionResponse>(() => {}));
    return Promise.race([zedLeg, phoneLeg]);
  };

  const spawned = spawnDownstream(
    { command: opts.command, args: opts.args, cwd: process.cwd() },
    () => proxyClient,
  );

  const proxyAgent = new HappyProxyAgent(() => spawned.connection, taps);

  // Strip the `terminal` capability from the forwarded `initialize` (see
  // stripTerminal / the file header). Everything else forwards verbatim.
  proxyAgent.initialize = (params) => spawned.connection.initialize(stripTerminal(params));

  const { writable, readable } = nodeToWebStreams(process.stdout, process.stdin);
  zed = new AgentSideConnection(() => proxyAgent, ndJsonStream(writable, readable));

  // Phone drives: a phone message becomes a prompt to the downstream, routed to
  // the session Zed established. Same sink as Zed's own prompts.
  relay.onUserMessage((text) => {
    if (!currentDownstreamSessionId) {
      return;
    }
    void spawned.connection
      .prompt({ sessionId: currentDownstreamSessionId, prompt: [{ type: 'text', text }] })
      .then(() => relay.endTurn('completed'))
      .catch((e) => logger.debug('[acp-agent] phone prompt failed', e));
  });

  // Stay alive until the Zed connection closes, then tear down.
  await new Promise<void>((resolve) => {
    zed.signal.addEventListener('abort', () => resolve());
  });
  await spawned.dispose();
  await relay.dispose();
}
