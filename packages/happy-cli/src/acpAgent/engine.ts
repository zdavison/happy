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
  /** Cancel any in-flight/queued work for the current turn. */
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

  let currentPermissionMode: PermissionMode = 'default';
  const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject(mode));
  const enhancedMode = (): EnhancedMode => ({ permissionMode: currentPermissionMode });

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
  });
  sessionRef = session;

  // Drive the session into remote mode once. The Session's own 2s keepAlive
  // (session.ts:85-88) sends `client.keepAlive(this.thinking, this.mode)`;
  // without this the mode stays 'local' and the reported control mode flaps
  // between local/remote. The `onModeChange` option we passed is a no-op here.
  session.onModeChange('remote');

  // Run the launcher for the session lifetime; do NOT await it here.
  const launcherDone = claudeRemoteLauncher(session).catch((e) => {
    logger.debug('[acp-agent] launcher exited', e);
  });

  return {
    happySessionId: response.id,
    push: (text, attachments) => messageQueue.push(text, enhancedMode(), attachments),
    setPermissionMode: (mode) => {
      currentPermissionMode = mode;
    },
    abort: async () => {
      messageQueue.reset();
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
