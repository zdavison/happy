/**
 * Bidirectional ACP proxy forwarders.
 *
 * `HappyProxyAgent` implements the ACP `Agent` interface that Zed (or any
 * ACP-speaking editor) talks to. Every call is forwarded verbatim down to the
 * downstream `ClientSideConnection` -- the real coding agent being proxied.
 *
 * `HappyProxyClient` implements the ACP `Client` interface that the
 * downstream agent talks to. Every call is forwarded verbatim up to Zed's
 * `AgentSideConnection`.
 *
 * Both classes accept a `ProxyTaps` object: side-observer callbacks fired
 * alongside the forwarded calls so the phone relay and permission-race layers
 * (later tasks) can observe traffic without altering it. Taps are pure
 * observers -- they never reshape params or responses, and the proxy classes
 * have no knowledge of what (if anything) consumes them.
 */
import type {
  Agent, Client, AgentSideConnection, ClientSideConnection,
  InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse,
  LoadSessionRequest, LoadSessionResponse, PromptRequest, PromptResponse,
  CancelNotification, SetSessionModeRequest, SetSessionModeResponse,
  SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
  SetSessionModelRequest, SetSessionModelResponse,
  ForkSessionRequest, ForkSessionResponse,
  ListSessionsRequest, ListSessionsResponse,
  ResumeSessionRequest, ResumeSessionResponse,
  AuthenticateRequest, AuthenticateResponse, SessionNotification,
  RequestPermissionRequest, RequestPermissionResponse,
  ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
  CreateTerminalRequest, CreateTerminalResponse,
} from '@agentclientprotocol/sdk';

export interface ProxyTaps {
  onSessionUpdate?(u: SessionNotification): void;
  onRequestPermission?(p: RequestPermissionRequest): void;
  onPrompt?(p: PromptRequest): void;
  onNewSession?(req: NewSessionRequest, res: NewSessionResponse): void;
  onPromptDone?(sessionId: string): void;
}

/**
 * Forwards every call Zed makes (as the ACP `Agent`) down to the downstream
 * `ClientSideConnection`. Raw pass-through: params and responses are forwarded
 * verbatim, never reshaped -- taps observe only.
 */
export class HappyProxyAgent implements Agent {
  constructor(
    private readonly getDownstream: () => ClientSideConnection,
    private readonly taps: ProxyTaps,
  ) {}

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return this.getDownstream().initialize(params);
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const res = await this.getDownstream().newSession(params);
    this.taps.onNewSession?.(params, res);
    return res;
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.getDownstream().loadSession(params);
  }

  unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    return this.getDownstream().unstable_forkSession(params);
  }

  unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.getDownstream().unstable_listSessions(params);
  }

  unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.getDownstream().unstable_resumeSession(params);
  }

  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return this.getDownstream().setSessionMode(params);
  }

  unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    return this.getDownstream().unstable_setSessionModel(params);
  }

  setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return this.getDownstream().setSessionConfigOption(params);
  }

  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.getDownstream().authenticate(params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.taps.onPrompt?.(params);
    const res = await this.getDownstream().prompt(params);
    this.taps.onPromptDone?.(params.sessionId);
    return res;
  }

  cancel(params: CancelNotification): Promise<void> {
    return this.getDownstream().cancel(params);
  }

  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.getDownstream().extMethod(method, params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.getDownstream().extNotification(method, params);
  }
}

/**
 * Forwards every call the downstream agent makes (as the ACP `Client`) up to
 * Zed's `AgentSideConnection`. Raw pass-through: params and responses are
 * forwarded verbatim, never reshaped -- taps observe only.
 *
 * `requestPermission` is intentionally simple here: it forwards to Zed and
 * fires the `onRequestPermission` tap. The 3-party first-wins race (phone /
 * Zed / auto-approve) is layered on top in a later task by replacing this
 * with a real racer -- do not build that here.
 */
export class HappyProxyClient implements Client {
  constructor(
    private readonly getZed: () => AgentSideConnection,
    private readonly taps: ProxyTaps,
  ) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.taps.onSessionUpdate?.(params);
    await this.getZed().sessionUpdate(params);
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.taps.onRequestPermission?.(params);
    return this.getZed().requestPermission(params);
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.getZed().readTextFile(params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.getZed().writeTextFile(params);
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    // AgentSideConnection.createTerminal returns a stateful TerminalHandle
    // (with .currentOutput()/.waitForExit()/.kill()/.release() methods), not
    // a plain CreateTerminalResponse. The Client interface's createTerminal
    // must return { terminalId }, so we unwrap the handle's id here. Terminal
    // output/wait/kill/release ops are NOT forwarded (see note below).
    const handle = await this.getZed().createTerminal(params);
    return { terminalId: handle.id };
  }

  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.getZed().extMethod(method, params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.getZed().extNotification(method, params);
  }
}
