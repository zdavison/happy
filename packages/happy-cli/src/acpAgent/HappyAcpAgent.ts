import type {
  Agent, AgentSideConnection,
  InitializeRequest, InitializeResponse,
  NewSessionRequest, NewSessionResponse,
  PromptRequest, PromptResponse,
  CancelNotification,
  SetSessionModeRequest, SetSessionModeResponse,
  AuthenticateRequest, AuthenticateResponse,
} from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

const PROTOCOL_VERSION = 1;

export class HappyAcpAgent implements Agent {
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

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    throw new Error('not implemented'); // Task 7
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    throw new Error('not implemented'); // Task 8
  }

  async setSessionMode(_params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    return; // Task 10
  }

  async cancel(params: CancelNotification): Promise<void> {
    logger.debug(`[acp-agent] cancel ${params.sessionId}`); // Task 10 wires the abort
  }
}
