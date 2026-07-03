import type {
  Agent, AgentSideConnection,
  InitializeRequest, InitializeResponse,
  NewSessionRequest, NewSessionResponse,
  PromptRequest, PromptResponse,
  CancelNotification,
  SetSessionModeRequest, SetSessionModeResponse,
  AuthenticateRequest, AuthenticateResponse,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
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
      onPermissionRequest: (_r) => {
        // Task 9: forward permission requests to the ACP client.
      },
      onPermissionResolved: (_id) => {
        // Task 9: notify the ACP client a permission was resolved.
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
  }

  private onSdkMessage(m: SDKMessage): void {
    if (!this.acpSessionId) {
      return;
    }
    for (const update of sdkMessageToUpdates(m)) {
      void this.connection.sessionUpdate({ sessionId: this.acpSessionId, update });
    }
    const stop = resultStopReason(m);
    if (stop) {
      const resolver = this.turnResolvers.shift();
      resolver?.(stop);
    }
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

  async setSessionMode(_params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    return; // Task 10
  }

  async cancel(params: CancelNotification): Promise<void> {
    logger.debug(`[acp-agent] cancel ${params.sessionId}`); // Task 10 wires the abort
  }
}
