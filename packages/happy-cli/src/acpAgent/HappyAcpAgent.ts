import type {
  Agent, AgentSideConnection,
  InitializeRequest, InitializeResponse,
  NewSessionRequest, NewSessionResponse,
  PromptRequest, PromptResponse,
  CancelNotification,
  SetSessionModeRequest, SetSessionModeResponse,
  AuthenticateRequest, AuthenticateResponse,
  StopReason,
  PermissionOption,
} from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { PermissionMode } from '@/claude/loop';
import type { SDKMessage } from '@/claude/sdk';
import { startEngine, type Engine } from './engine';
import { sdkMessageToUpdates, resultStopReason } from './sdkMessageToAcp';
import { parsePromptBlocks } from './contentBlocks';

const PROTOCOL_VERSION = 1;

export class HappyAcpAgent implements Agent {
  private engine: Engine | null = null;
  private acpSessionId: string | null = null;
  private turnResolvers: Array<(reason: StopReason) => void> = [];

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly credentials: Credentials,
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'happy', version: '0.0.0' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    // Happy authenticates via its own account secret at session-registration time.
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.engine) {
      throw new Error('this agent supports a single session per process');
    }
    const sessionId = `acp-${Date.now().toString(36)}`;
    this.acpSessionId = sessionId;
    this.engine = await startEngine({
      credentials: this.credentials,
      cwd: params.cwd,
      onAgentSdkMessage: (m) => this.onSdkMessage(m),
      onPermissionRequest: (r) => this.onPermissionRequest(r),
      onPermissionResolved: (_id) => {
        // First-answer-wins is enforced by resolveExternally returning false
        // once a request is resolved; no per-request bookkeeping needed here.
      },
      onEngineClosed: () => this.onEngineClosed(),
    });
    return { sessionId };
  }

  /**
   * The Claude launcher died (or exited) without producing a `result` SDK
   * message. Without this, an in-flight `prompt` would await its resolver
   * forever. Unblock any outstanding turn(s) so the ACP client gets a
   * response instead of a hang.
   */
  private onEngineClosed(): void {
    const resolvers = this.turnResolvers.splice(0, this.turnResolvers.length);
    for (const resolve of resolvers) {
      resolve('cancelled');
    }
    // Mark the engine dead so a NEW prompt issued after the launcher died hits
    // the `if (!this.engine) throw` guard instead of pushing into a defunct
    // queue and hanging forever with nothing left to rescue it.
    this.engine = null;
    this.acpSessionId = null;
  }

  private onSdkMessage(m: SDKMessage): void {
    if (!this.acpSessionId) {
      return;
    }
    for (const update of sdkMessageToUpdates(m)) {
      void this.connection.sessionUpdate({ sessionId: this.acpSessionId, update });
    }
    // ACP guarantees at most one editor `prompt` is in flight at a time (Zed
    // awaits each prompt response before sending the next), so the head resolver
    // always belongs to the editor's current turn. A `result` also fires for
    // phone-driven turns, so we only resolve the editor's pending prompt once the
    // engine is fully idle (nothing queued/running). This never resolves early:
    // if a phone turn interleaves, the editor prompt resolves once all queued
    // activity settles (a slight, acceptable over-wait; the editor still receives
    // every streamed update meanwhile). A non-null `stop` while the engine is NOT
    // idle is intentionally skipped (a phone turn finished but the editor's own
    // turn is still queued/running).
    const stop = resultStopReason(m);
    if (stop && this.engine?.isIdle()) {
      this.turnResolvers.shift()?.(stop);
    }
  }

  /**
   * Claude gated a tool. Forward the request to the ACP editor via
   * `requestPermission` and, when it answers with a selected option, route the
   * decision back through the engine's `resolvePermission` (which uses the
   * shared `resolveExternally` path). If the phone answered first,
   * `resolveExternally` returns false and the editor's late answer is a
   * harmless no-op.
   */
  private onPermissionRequest(r: { id: string; toolName: string; input: unknown }): void {
    if (!this.acpSessionId) {
      return;
    }
    const options: PermissionOption[] = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ];
    void this.connection.requestPermission({
      sessionId: this.acpSessionId,
      toolCall: { toolCallId: r.id, title: r.toolName, rawInput: r.input, status: 'pending' },
      options,
    }).then((resp) => {
      if (resp.outcome.outcome === 'selected') {
        this.engine?.resolvePermission(r.id, resp.outcome.optionId === 'allow');
      }
    }).catch((err) => {
      logger.debug('[acp-agent] requestPermission failed', err);
    });
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.engine) throw new Error('no active session');
    const { text, attachments } = parsePromptBlocks(params.prompt);
    const stopReason = await new Promise<StopReason>((resolve) => {
      this.turnResolvers.push(resolve);
      this.engine!.push(text, attachments);
    });
    return { stopReason };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    const map: Record<string, PermissionMode> = {
      default: 'default',
      acceptEdits: 'acceptEdits',
      bypassPermissions: 'bypassPermissions',
      plan: 'plan',
    };
    const mode = map[params.modeId] ?? 'default';
    this.engine?.setPermissionMode(mode);
    return;
  }

  async cancel(_params: CancelNotification): Promise<void> {
    await this.engine?.abort();
  }

  /**
   * Tear down the engine (stops the launcher, cleans up the temp hook-settings
   * file, closes the Happy session). Called on connection teardown.
   */
  async dispose(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.acpSessionId = null;
    await engine?.dispose();
  }
}
