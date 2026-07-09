/**
 * Phone relay: Phase-1 (ACP-tier) tap mapper.
 *
 * Maps a raw ACP `SessionUpdate` directly into Happy `SessionEnvelope`s for
 * the phone, without going through Happy's internal `AgentMessage` layer.
 * This is a pure, best-effort mapping — see `sessionUpdateToEnvelopes` for the
 * exact list of what is covered today and what remains for future enrichment.
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
} from '@agentclientprotocol/sdk';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { type Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import type { PermissionResult } from '@/utils/BasePermissionHandler';
import { resolveSessionFlavor } from '@/agent/acp/acpSessionFlavor';
import { GenericAcpPermissionHandler } from '@/agent/acp/genericAcpPermissionHandler';
import { extractPermissionRequestInput, permissionResultToOutcome } from '@/agent/acp/acpPermissionMapping';
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
 *
 * Covered today (ACP tier):
 *  - `agent_message_chunk` / `agent_thought_chunk` — `text` content only.
 *  - `tool_call` — title + args (as `tool-call-start`).
 *  - `tool_call_update` — terminal `completed`/`failed` status (as `tool-call-end`).
 *
 * Everything else maps to `[]` today and is the remaining enrichment work:
 *  - Non-`text` content blocks (`image`, `audio`, `resource`, `resource_link`)
 *    inside message/thought chunks.
 *  - `tool_call_update` with non-terminal status: streamed tool output, diffs,
 *    and status/label changes mid-call.
 *  - Richer `tool_call` fields: `kind`, `locations`, `content`/diffs, `rawOutput`.
 *  - Other update variants: `user_message_chunk`, `plan`,
 *    `available_commands_update`, `current_mode_update`, `config_option_update`,
 *    `session_info_update`, `usage_update`.
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

type HappyServerHandle = Awaited<ReturnType<typeof startHappyServer>>;

/**
 * PhoneRelay wires an ACP proxy session to a Happy server session so it shows
 * up (and is drivable) from the phone. It:
 *  - bootstraps a Happy server session,
 *  - streams downstream ACP `SessionUpdate`s to the phone via
 *    `sessionUpdateToEnvelopes` + `session.sendSessionProtocolMessage`,
 *  - accepts phone prompts through `session.onUserMessage`,
 *  - surfaces tool-permission requests to the phone (`GenericAcpPermissionHandler`)
 *    and maps the ACP request/response via `acpPermissionMapping`.
 *
 * The tap-facing methods (`startTurn`/`pushUpdate`/`endTurn`) never throw — a
 * relay hiccup must not abort the upstream↔downstream forward path.
 */
export class PhoneRelay {
  private turnId: string | null = null;
  private disposed = false;

  private constructor(
    public readonly happySessionId: string,
    private session: ApiSessionClient,
    private readonly permissionHandler: GenericAcpPermissionHandler,
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

    const permissionHandler = new GenericAcpPermissionHandler(initialSession, opts.agentName);
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

  /** Register a callback for phone→proxy prompt text. */
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
   * `GenericAcpPermissionHandler.handleToolCall` → ACP `RequestPermissionResponse`,
   * resolving option ids from the request's own `options` (by `kind`).
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

  /**
   * Cancel a still-pending phone permission prompt — used when another party
   * (e.g. the upstream editor/UI) has already answered the same request.
   * Non-throwing (may be called from a race-cleanup path).
   */
  cancelPermission(request: RequestPermissionRequest, reason: string): void {
    try {
      const { toolCallId } = extractPermissionRequestInput(request);
      this.permissionHandler.cancelPending(toolCallId, reason);
    } catch (error) {
      logger.debug('[PhoneRelay] cancelPermission failed:', error);
    }
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
