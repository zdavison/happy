/**
 * Headless Claude engine for the ACP agent.
 *
 * Stands up a Happy session and drives real Claude Code via the existing
 * `claudeRemoteLauncher(session)`. This mirrors the bootstrap in
 * `src/claude/runClaude.ts` and `src/agent/acp/runAcp.ts`, assembled headless
 * (no terminal UI, no stdout — all logging goes through the file `logger`).
 *
 * The launcher runs for the whole session lifetime and is intentionally NOT
 * awaited; the engine exposes the message queue so `prompt` can push work and
 * the ACP taps (`onAgentSdkMessage` / `onPermissionRequest` /
 * `onPermissionResolved`) so the agent can translate the SDK stream to ACP
 * `session/update` notifications.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { Session } from '@/claude/session';
import { claudeRemoteLauncher } from '@/claude/claudeRemoteLauncher';
import type { PermissionHandler } from '@/claude/utils/permissionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { hashObject } from '@/utils/deterministicJson';
import { logger } from '@/ui/logger';
import type { EnhancedMode, PermissionMode } from '@/claude/loop';
import type { SDKMessage } from '@/claude/sdk';

export interface Engine {
  /** Happy server session id (the id shown in the mobile/web app). */
  happySessionId: string;
  /** Queue a user prompt (optionally with decoded attachments) for the next turn. */
  push(text: string, attachments?: PendingAttachment[]): void;
  /** Update the permission mode applied to subsequently pushed prompts. */
  setPermissionMode(mode: PermissionMode): void;
  /**
   * Resolve a pending tool-permission request from outside the phone RPC flow
   * (used by the ACP editor). Routes through the same `resolveExternally` path
   * the phone uses, so first-answer-wins is enforced by the handler.
   */
  resolvePermission(id: string, approved: boolean): void;
  /**
   * True when nothing is queued or running (message queue is empty). Used by the
   * ACP agent to know a `result` has settled all activity before resolving the
   * editor's pending prompt.
   */
  isIdle(): boolean;
  /** Cancel the in-flight turn (real interrupt, does not drop queued prompts). */
  abort(): Promise<void>;
  /** Tear the engine down and release all resources. */
  dispose(): Promise<void>;
}

export async function startEngine(opts: {
  credentials: Credentials;
  cwd: string;
  onAgentSdkMessage: (m: SDKMessage) => void;
  onPermissionRequest: (r: { id: string; toolName: string; input: unknown }) => void;
  onPermissionResolved: (id: string) => void;
  /**
   * Fires once the launcher promise settles (success or failure), i.e. the
   * underlying Claude process is no longer driving this session. Lets callers
   * (the ACP agent) unblock anything still waiting on turn completion instead
   * of hanging forever if the launcher dies without emitting a `result`.
   */
  onEngineClosed?: () => void;
}): Promise<Engine> {
  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings; run `happy auth` first');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'claude',
    machineId: settings.machineId,
    startedBy: 'terminal',
    sandbox: settings.sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
  if (!response) {
    throw new Error('Failed to create Happy session (offline?)');
  }
  const client = api.sessionSyncClient(response);

  const happyServer = await startHappyServer(client);

  // The Session is created AFTER startHookServer, so the hook callback reads
  // the Session through a mutable ref captured by the closure. The body is
  // deliberately minimal: it only updates the Claude session id on the Session
  // (runClaude additionally drives a remoteScanner we do not have here).
  let sessionRef: Session | null = null;
  const hookServer = await startHookServer({
    onSessionHook: (sessionId) => {
      if (sessionRef && sessionRef.sessionId !== sessionId) {
        sessionRef.onSessionFound(sessionId);
      }
    },
  });
  const hookSettingsPath = generateHookSettingsFile(hookServer.port);

  // Captured once the launcher constructs its PermissionHandler; used by
  // resolvePermission to route the editor's answer through resolveExternally.
  let permissionHandlerRef: PermissionHandler | null = null;

  let currentPermissionMode: PermissionMode = 'default';
  const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject(mode));
  const enhancedMode = (): EnhancedMode => ({ permissionMode: currentPermissionMode });

  // Captured once the launcher registers its `abort` RPC; used by Engine.abort
  // to trigger the real interrupt (abortController.abort()).
  let abortHandle: (() => void) | null = null;

  // Wire relayed phone prompts into the same queue the editor's prompts use so
  // the phone can DRIVE (not just observe) the session. Mirrors runAcp.ts's
  // simpler onUserMessage handler (no attachment draining here).
  client.onUserMessage((message) => {
    if (!message?.content?.text) return;
    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode as PermissionMode;
    }
    messageQueue.push(message.content.text, enhancedMode(), undefined);
  });

  const session = new Session({
    api,
    client,
    path: opts.cwd,
    sessionId: null,
    logPath: logger.logFilePath,
    messageQueue,
    mcpServers: {
      happy: {
        type: 'http' as const,
        url: happyServer.url,
      },
    },
    allowedTools: happyServer.toolNames.map((toolName) => `mcp__happy__${toolName}`),
    onModeChange: () => {
      // Headless: never switch to local/terminal mode.
    },
    onAbort: () => {
      // No mode-default reset state to unwind headless.
    },
    hookSettingsPath,
    onAgentSdkMessage: opts.onAgentSdkMessage,
    onPermissionRequest: opts.onPermissionRequest,
    onPermissionResolved: opts.onPermissionResolved,
    onPermissionHandlerReady: (h) => {
      permissionHandlerRef = h;
    },
    onAbortReady: (abort) => {
      abortHandle = abort;
    },
  });
  sessionRef = session;

  // Drive the session into remote mode once. The Session's own 2s keepAlive
  // (session.ts:85-88) sends `client.keepAlive(this.thinking, this.mode)`;
  // without this the mode stays 'local' and the reported control mode flaps
  // between local/remote. The `onModeChange` option we passed is a no-op here.
  session.onModeChange('remote');

  // Run the launcher for the session lifetime; do NOT await it here.
  const launcherDone = claudeRemoteLauncher(session)
    .catch((e) => {
      logger.debug('[acp-agent] launcher exited', e);
    })
    .finally(() => {
      opts.onEngineClosed?.();
    });

  return {
    happySessionId: response.id,
    push: (text, attachments) => messageQueue.push(text, enhancedMode(), attachments),
    setPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
    resolvePermission: (id, approved) => {
      permissionHandlerRef?.resolveExternally(id, { approved });
    },
    isIdle: () => messageQueue.size() === 0,
    abort: async () => {
      // Trigger the launcher's real interrupt (abortController.abort()). We do
      // NOT reset the queue: queued phone prompts should survive a cancel of the
      // current turn, and reset() would null the queue waiter without resolving
      // it (a potential hang).
      abortHandle?.();
    },
    dispose: async () => {
      messageQueue.close();
      await launcherDone;
      session.cleanup();
      happyServer.stop();
      hookServer.stop();
      cleanupHookSettingsFile(hookSettingsPath);
      await client.flush();
      await client.close();
    },
  };
}
