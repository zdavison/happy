/**
 * Phone relay: Phase-1 (ACP-tier) tap mapper.
 *
 * Maps a raw ACP `SessionUpdate` directly into Happy `SessionEnvelope`s for
 * the phone, without going through Happy's internal `AgentMessage` layer.
 * This is a pure, best-effort mapping — it only handles the four core
 * variants exercised by the ACP proxy (text/thinking chunks and tool-call
 * start/end); everything else maps to `[]` and is left for the enrichment
 * done in later phases.
 *
 * Mirrors the envelope shapes built by `AcpSessionManager`
 * (`src/agent/acp/AcpSessionManager.ts`), which remains the source of truth
 * for `createEnvelope`/`turnOptions` usage.
 */
import { randomUUID } from 'node:crypto';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type {
  SessionUpdate,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
} from '@agentclientprotocol/sdk';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { type Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { logger } from '@/ui/logger';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

/**
 * Monotonic clock, mirroring `AcpSessionManager.nextTime()`: max(lastTime + 1, Date.now()).
 * Module-level so envelope ordering stays stable even if this pure function is
 * called multiple times within the same millisecond.
 */
let lastTime = 0;
function nextTime(): number {
  lastTime = Math.max(lastTime + 1, Date.now());
  return lastTime;
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

/** Coerce ACP's `rawInput: unknown` into the record shape `tool-call-start` requires. */
function toArgsRecord(rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  return {};
}

/**
 * Maps a raw ACP `SessionUpdate` into zero or more Happy `SessionEnvelope`s
 * for the phone. Pure function: no I/O, no console output.
 */
export function sessionUpdateToEnvelopes(update: SessionUpdate, turnId: string | null): SessionEnvelope[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text') {
        return [];
      }
      return [createEnvelope('agent', { t: 'text', text: update.content.text }, turnOptions(turnId, nextTime()))];
    }
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') {
        return [];
      }
      return [createEnvelope('agent', { t: 'text', text: update.content.text, thinking: true }, turnOptions(turnId, nextTime()))];
    }
    case 'tool_call': {
      return [createEnvelope('agent', {
        t: 'tool-call-start',
        call: update.toolCallId,
        name: update.title,
        title: buildToolTitle(update.title),
        description: buildToolDescription(update.title),
        args: toArgsRecord(update.rawInput),
      }, turnOptions(turnId, nextTime()))];
    }
    case 'tool_call_update': {
      if (update.status === 'completed' || update.status === 'failed') {
        return [createEnvelope('agent', { t: 'tool-call-end', call: update.toolCallId }, turnOptions(turnId, nextTime()))];
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * Maps `agentName` to a Happy session flavor. Mirrors
 * `resolveSessionFlavor` in `src/agent/acp/runAcp.ts:439-447` — the ACP proxy
 * reuses the same three-way classification (default `'acp'`).
 */
function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  return 'acp';
}

type HappyServerHandle = Awaited<ReturnType<typeof startHappyServer>>;

/**
 * Phone-side permission handler for the ACP proxy.
 *
 * Mirrors `GenericAcpPermissionHandler` (`src/agent/acp/runAcp.ts:407-431`):
 * a `BasePermissionHandler` subclass whose `handleToolCall` parks a pending
 * promise (keyed by `toolCallId`), pushes the request into agent state via
 * `addPendingRequestToState`, and lets the `permission` RPC — registered by
 * `BasePermissionHandler.setupRpcHandler` — resolve it once the phone answers.
 */
class PhonePermissionHandler extends BasePermissionHandler {
  private readonly logPrefix: string;

  constructor(session: ApiSessionClient, agentName: string) {
    super(session);
    this.logPrefix = `[${agentName}]`;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}

/** Extended shape covering non-standard `toolCall`/param fields other ACP agents emit. */
type ExtendedPermissionRequest = RequestPermissionRequest & {
  toolCall?: RequestPermissionRequest['toolCall'] & {
    id?: string;
    toolName?: string;
    input?: unknown;
    arguments?: unknown;
    content?: unknown;
  };
};

/**
 * Pulls `{ toolCallId, toolName, input }` out of an ACP `RequestPermissionRequest`,
 * mirroring the field-fallback order in `AcpBackend.ts:509-524`. Exported for tests.
 */
export function extractPermissionRequestInput(request: RequestPermissionRequest): {
  toolCallId: string;
  toolName: string;
  input: unknown;
} {
  const toolCall = (request as ExtendedPermissionRequest).toolCall;
  return {
    toolCallId: toolCall?.toolCallId ?? toolCall?.id ?? randomUUID(),
    toolName: toolCall?.kind ?? toolCall?.toolName ?? toolCall?.title ?? 'Unknown tool',
    input: toolCall?.rawInput ?? toolCall?.input ?? toolCall?.arguments ?? toolCall?.content ?? {},
  };
}

/**
 * Maps a resolved `PermissionResult` to an ACP `RequestPermissionResponse`,
 * choosing the option id from the request's own `options` by `kind` (never
 * hardcoded). Mirrors `AcpBackend.ts:580-644`. Exported for tests.
 */
export function permissionResultToOutcome(
  result: PermissionResult,
  options: PermissionOption[],
): RequestPermissionResponse {
  const allowOnce = options.find((opt) => opt.kind === 'allow_once');
  const allowAlways = options.find((opt) => opt.kind === 'allow_always');
  const allowAny = options.find((opt) => opt.kind.startsWith('allow'));
  const rejectAny = options.find((opt) => opt.kind === 'reject_once' || opt.kind === 'reject_always');

  if (result.decision === 'approved' || result.decision === 'approved_for_session') {
    const chosen: PermissionOption | undefined =
      result.decision === 'approved_for_session'
        ? (allowAlways ?? allowOnce ?? allowAny)
        : (allowOnce ?? allowAlways ?? allowAny);
    if (chosen) {
      return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  // denied / abort
  if (rejectAny) {
    return { outcome: { outcome: 'selected', optionId: rejectAny.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * PhoneRelay wires an ACP proxy session to a Happy server session so it shows
 * up (and is drivable) from the phone. It:
 *  - bootstraps a Happy server session (mirrors `runAcp.ts:449-537`),
 *  - streams downstream ACP `SessionUpdate`s to the phone via
 *    `sessionUpdateToEnvelopes` + `session.sendSessionProtocolMessage`,
 *  - accepts phone prompts through `session.onUserMessage`,
 *  - surfaces tool-permission requests to the phone (`PhonePermissionHandler`)
 *    and maps the ACP request/response the way `AcpBackend.ts:507-644` does.
 *
 * The tap-facing methods (`startTurn`/`pushUpdate`/`endTurn`) never throw — a
 * relay hiccup must not abort the Zed↔downstream forward path.
 */
export class PhoneRelay {
  private turnId: string | null = null;
  private disposed = false;

  private constructor(
    public readonly happySessionId: string,
    private session: ApiSessionClient,
    private readonly permissionHandler: PhonePermissionHandler,
    private readonly happyServer: HappyServerHandle,
    private readonly keepAliveInterval: NodeJS.Timeout,
    private readonly reconnectionHandle: { cancel(): void } | null,
  ) {}

  static async start(opts: { credentials: Credentials; agentName: string }): Promise<PhoneRelay> {
    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings?.machineId) {
      throw new Error("No machine ID found in settings; run 'happy' once to log in");
    }

    await api.getOrCreateMachine({
      machineId: settings.machineId,
      metadata: initialMachineMetadata,
    });

    const { state, metadata } = createSessionMetadata({
      flavor: resolveSessionFlavor(opts.agentName),
      machineId: settings.machineId,
      startedBy: 'terminal',
      sandbox: settings.sandboxConfig,
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Late-bound reference so the reconnection swap can reach the constructed
    // relay (the swap only fires asynchronously, after `relay` is assigned).
    let relay: PhoneRelay | undefined;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
      api,
      sessionTag,
      metadata,
      state,
      response,
      onSessionSwap: (newSession) => {
        relay?.handleSessionSwap(newSession);
      },
    });

    const permissionHandler = new PhonePermissionHandler(initialSession, opts.agentName);
    const happyServer = await startHappyServer(initialSession);

    const keepAliveInterval = setInterval(() => {
      try {
        relay?.session.keepAlive(false, 'remote');
      } catch (error) {
        logger.debug('[PhoneRelay] keepAlive failed:', error);
      }
    }, 2000);

    relay = new PhoneRelay(
      response?.id ?? sessionTag,
      initialSession,
      permissionHandler,
      happyServer,
      keepAliveInterval,
      reconnectionHandle,
    );
    return relay;
  }

  private handleSessionSwap(newSession: ApiSessionClient): void {
    this.session = newSession;
    this.permissionHandler.updateSession(newSession);
  }

  /** Begin a phone-visible turn. Non-throwing (tap-facing). */
  startTurn(): void {
    try {
      if (this.turnId) {
        return;
      }
      this.turnId = randomUUID();
      this.session.sendSessionProtocolMessage(
        createEnvelope('agent', { t: 'turn-start' }, { turn: this.turnId, time: nextTime() }),
      );
    } catch (error) {
      logger.debug('[PhoneRelay] startTurn failed:', error);
    }
  }

  /** End the current phone-visible turn. Non-throwing (tap-facing). */
  endTurn(status: 'completed' | 'failed' | 'cancelled'): void {
    try {
      const turnId = this.turnId;
      this.turnId = null;
      if (turnId) {
        this.session.sendSessionProtocolMessage(
          createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: nextTime() }),
        );
      }
      this.session.sendSessionEvent({ type: 'ready' });
    } catch (error) {
      logger.debug('[PhoneRelay] endTurn failed:', error);
    }
  }

  /** Stream a downstream ACP update to the phone. Non-throwing (tap-facing). */
  pushUpdate(update: SessionNotification): void {
    try {
      for (const envelope of sessionUpdateToEnvelopes(update.update, this.turnId)) {
        this.session.sendSessionProtocolMessage(envelope);
      }
    } catch (error) {
      logger.debug('[PhoneRelay] pushUpdate failed:', error);
    }
  }

  /** Register a callback for phone→proxy prompt text. Mirrors `runAcp.ts:833`. */
  onUserMessage(cb: (text: string) => void): void {
    this.session.onUserMessage((message) => {
      if (message?.content?.text) {
        cb(message.content.text);
      }
    });
  }

  /**
   * Surface a downstream tool-permission request to the phone and resolve it
   * with the phone's answer. Maps the ACP `RequestPermissionRequest` →
   * `PhonePermissionHandler.handleToolCall` → ACP `RequestPermissionResponse`
   * exactly like `AcpBackend.ts:507-644`, but resolves option ids from the
   * request's own `options` (by `kind`) rather than hardcoding them.
   */
  async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const { toolCallId, toolName, input } = extractPermissionRequestInput(request);
    let result: PermissionResult;
    try {
      result = await this.permissionHandler.handleToolCall(toolCallId, toolName, input);
    } catch (error) {
      logger.debug('[PhoneRelay] permission request failed:', error);
      return { outcome: { outcome: 'cancelled' } };
    }
    return permissionResultToOutcome(result, request.options ?? []);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.keepAliveInterval);
    this.reconnectionHandle?.cancel();
    try {
      this.permissionHandler.reset('Phone relay disposed');
    } catch (error) {
      logger.debug('[PhoneRelay] permission handler reset failed:', error);
    }
    try {
      this.happyServer.stop();
    } catch (error) {
      logger.debug('[PhoneRelay] happy server stop failed:', error);
    }
    try {
      await this.session.flush();
      await this.session.close();
    } catch (error) {
      logger.debug('[PhoneRelay] session close failed:', error);
    }
  }
}
