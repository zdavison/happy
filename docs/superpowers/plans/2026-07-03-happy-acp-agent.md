# Happy ACP Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless `happy acp-agent` mode that speaks the Agent Client Protocol as a *server* over stdio, so an ACP editor (Zed) drives the same Happy-owned Claude Code session the phone drives.

**Architecture:** One `happy` process, spawned by the editor, faces two ways: down to the editor via `AgentSideConnection` over stdin/stdout (JSON-RPC), and up to the phone via the existing `ApiSessionClient` server relay. In the middle it drives real Claude Code through the existing, terminal-free `claudeRemoteLauncher` path. Claude's SDK message stream is *mirrored*: the launcher already forwards it to the phone (`sendClaudeSessionMessage`), and a new tap forwards it to the editor as ACP `session/update` notifications. Permission requests are bridged so either client can approve.

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk` (already a dependency), `@anthropic-ai/claude-agent-sdk`, `socket.io-client`, `vitest`. Package: `packages/happy-cli`.

## Global Constraints

- **Headless / stdout is sacred.** In `acp-agent` mode, nothing may write to `process.stdout` except ACP JSON-RPC frames. All human/debug output goes to `process.stderr` or the file logger (`@/ui/logger`). Never use `console.log`. Never pass `stdio: 'inherit'` / never run the local (terminal) Claude launcher.
- **Reuse over reimplementation.** Drive Claude via the existing `claudeRemoteLauncher(session)`; do not replicate the SDK query loop or the phone-relay converter. New code is a thin ACP translation layer plus small additive taps on existing files.
- **ACP correct wire.** Use `@agentclientprotocol/sdk` (`AgentSideConnection`, `ndJsonStream`) — the same package the existing client uses (`packages/happy-cli/src/agent/acp/AcpBackend.ts`).
- **v1 scope.** Soft-floor control (no `requestControl` RPC), rest-only takeover (falls out of turn serialization), Claude backend only. Out of scope: hard single-active-driver, mid-turn takeover, `loadSession` thread restore, non-Claude backends, routing file IO through the editor's `fs` capability.
- **Follow existing patterns.** `runAcpAgent` parallels `runAcp` (`src/agent/acp/runAcp.ts`) and `runClaude` (`src/claude/runClaude.ts`) — bootstrap with `ApiClient.create` → `getOrCreateSession` → `sessionSyncClient` → `startHappyServer`/hooks → `new Session` → `claudeRemoteLauncher`.
- **Design source of truth:** `docs/superpowers/specs/2026-07-03-happy-acp-agent-surface-design.md`.

## File Structure

New (all under `packages/happy-cli/src/acpAgent/`):
- `contentBlocks.ts` — pure: ACP `ContentBlock[]` → `{ text, attachments }` for the message queue. **Testable.**
- `sdkMessageToAcp.ts` — pure: one `SDKMessage` → `SessionUpdate[]` (text/thinking/tool_call/tool_call_update) + turn-end detection. **Testable.**
- `permissionBridge.ts` — bridges the native `PermissionHandler` observer hooks ↔ `AgentSideConnection.requestPermission`. **Partly testable.**
- `HappyAcpAgent.ts` — implements the SDK `Agent` interface (`initialize`/`newSession`/`prompt`/`cancel`/`setSessionMode`/`authenticate`); owns the ACP↔Happy session mapping and the engine bootstrap.
- `runAcpAgent.ts` — entrypoint: builds `AgentSideConnection` over stdio, keeps the process alive until the connection closes.
- Tests: `contentBlocks.test.ts`, `sdkMessageToAcp.test.ts`, `runAcpAgent.integration.test.ts`.

Modified (small, additive):
- `src/index.ts` — add the `acp-agent` subcommand branch.
- `src/claude/session.ts` — add optional taps: `onAgentSdkMessage?`, `onPermissionRequest?`, `onPermissionResolved?`.
- `src/claude/claudeRemoteLauncher.ts` — call `session.onAgentSdkMessage?.(message)` inside its `onMessage`.
- `src/claude/utils/permissionHandler.ts` — fire the observer hooks and add a public `resolveExternally(id, response)`.

---

## Phase 1 — Pure translators (TDD, no integration)

### Task 1: ACP ContentBlock → queue text

**Files:**
- Create: `packages/happy-cli/src/acpAgent/contentBlocks.ts`
- Test: `packages/happy-cli/src/acpAgent/contentBlocks.test.ts`

**Interfaces:**
- Consumes: `ContentBlock` from `@agentclientprotocol/sdk` (union; `type: 'text' | 'image' | 'resource' | 'resource_link' | 'audio'`).
- Produces: `parsePromptBlocks(blocks: ContentBlock[]): { text: string; attachments: PendingAttachment[] }` where `PendingAttachment = { data: Uint8Array; mimeType: string; name: string }` (from `@/utils/MessageQueue2`).

- [ ] **Step 1: Write the failing test**

```ts
// contentBlocks.test.ts
import { describe, it, expect } from 'vitest';
import { parsePromptBlocks } from './contentBlocks';

describe('parsePromptBlocks', () => {
  it('joins text blocks with newlines', () => {
    const out = parsePromptBlocks([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ] as any);
    expect(out.text).toBe('hello\nworld');
    expect(out.attachments).toEqual([]);
  });

  it('extracts base64 image blocks as attachments', () => {
    const b64 = Buffer.from([1, 2, 3]).toString('base64');
    const out = parsePromptBlocks([
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: b64 },
    ] as any);
    expect(out.text).toBe('look');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].mimeType).toBe('image/png');
    expect(Array.from(out.attachments[0].data)).toEqual([1, 2, 3]);
  });

  it('renders resource_link as a text mention', () => {
    const out = parsePromptBlocks([
      { type: 'resource_link', uri: 'file:///a/b.ts', name: 'b.ts' },
    ] as any);
    expect(out.text).toContain('b.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/contentBlocks.test.ts`
Expected: FAIL — `Cannot find module './contentBlocks'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// contentBlocks.ts
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PendingAttachment } from '@/utils/MessageQueue2';

export function parsePromptBlocks(blocks: ContentBlock[]): { text: string; attachments: PendingAttachment[] } {
  const textParts: string[] = [];
  const attachments: PendingAttachment[] = [];
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text);
        break;
      case 'image':
      case 'audio':
        if ('data' in block && typeof block.data === 'string') {
          attachments.push({
            data: new Uint8Array(Buffer.from(block.data, 'base64')),
            mimeType: ('mimeType' in block && block.mimeType) || 'application/octet-stream',
            name: 'name' in block && block.name ? String(block.name) : 'attachment',
          });
        }
        break;
      case 'resource_link':
        textParts.push(`@${block.name ?? block.uri}`);
        break;
      case 'resource':
        if ('resource' in block && block.resource && 'text' in block.resource && typeof block.resource.text === 'string') {
          textParts.push(block.resource.text);
        }
        break;
    }
  }
  return { text: textParts.join('\n'), attachments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/contentBlocks.test.ts`
Expected: PASS (3 tests). If a `ContentBlock` field name differs, open `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` and grep `ContentBlock` / `ImageContent` to correct property access, then re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/acpAgent/contentBlocks.ts packages/happy-cli/src/acpAgent/contentBlocks.test.ts
git commit -m "feat(cli): parse ACP prompt content blocks into queue text + attachments"
```

---

### Task 2: SDKMessage → ACP session updates

**Files:**
- Create: `packages/happy-cli/src/acpAgent/sdkMessageToAcp.ts`
- Test: `packages/happy-cli/src/acpAgent/sdkMessageToAcp.test.ts`

**Background:** `SDKMessage` (from `@anthropic-ai/claude-agent-sdk`, re-exported via `@/claude/sdk`) is a large union. We map only what the editor panel needs:
- `type: 'assistant'` (`SDKAssistantMessage`) → its `message.content[]` blocks: `text` → `agent_message_chunk`, `thinking` → `agent_thought_chunk`, `tool_use` → `tool_call`.
- `type: 'user'` with `tool_result` content → `tool_call_update` (completed).
- `type: 'result'` (`SDKResultMessage`) → no update; signals turn end (caller resolves the prompt). Return its stop reason mapping.

**Interfaces:**
- Consumes: `SDKMessage` from `@/claude/sdk`.
- Produces:
  - `sdkMessageToUpdates(msg: SDKMessage): SessionUpdate[]` (`SessionUpdate` from `@agentclientprotocol/sdk`).
  - `resultStopReason(msg: SDKMessage): StopReason | null` — non-null only for `type: 'result'`; `StopReason` from `@agentclientprotocol/sdk`.

- [ ] **Step 1: Write the failing test**

```ts
// sdkMessageToAcp.test.ts
import { describe, it, expect } from 'vitest';
import { sdkMessageToUpdates, resultStopReason } from './sdkMessageToAcp';

const assistant = (content: any[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
} as any);

describe('sdkMessageToUpdates', () => {
  it('maps assistant text to agent_message_chunk', () => {
    const [u] = sdkMessageToUpdates(assistant([{ type: 'text', text: 'hi' }]));
    expect(u.sessionUpdate).toBe('agent_message_chunk');
    expect((u as any).content).toEqual({ type: 'text', text: 'hi' });
  });

  it('maps thinking to agent_thought_chunk', () => {
    const [u] = sdkMessageToUpdates(assistant([{ type: 'thinking', thinking: 'hmm' }]));
    expect(u.sessionUpdate).toBe('agent_thought_chunk');
    expect((u as any).content).toEqual({ type: 'text', text: 'hmm' });
  });

  it('maps tool_use to tool_call with id and title', () => {
    const [u] = sdkMessageToUpdates(assistant([
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
    ]));
    expect(u.sessionUpdate).toBe('tool_call');
    expect((u as any).toolCallId).toBe('tu_1');
    expect((u as any).title).toContain('Bash');
  });

  it('returns [] for result messages', () => {
    expect(sdkMessageToUpdates({ type: 'result', subtype: 'success' } as any)).toEqual([]);
  });
});

describe('resultStopReason', () => {
  it('maps success to end_turn', () => {
    expect(resultStopReason({ type: 'result', subtype: 'success' } as any)).toBe('end_turn');
  });
  it('returns null for non-result', () => {
    expect(resultStopReason({ type: 'assistant', message: { content: [] } } as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/sdkMessageToAcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// sdkMessageToAcp.ts
import type { SDKMessage } from '@/claude/sdk';
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';

export function sdkMessageToUpdates(msg: SDKMessage): SessionUpdate[] {
  if (msg.type !== 'assistant') return [];
  const content = (msg as any).message?.content;
  if (!Array.isArray(content)) return [];
  const updates: SessionUpdate[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } } as SessionUpdate);
        break;
      case 'thinking':
        if (block.thinking) updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking } } as SessionUpdate);
        break;
      case 'tool_use':
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          title: `${block.name}`,
          status: 'in_progress',
          rawInput: block.input,
        } as SessionUpdate);
        break;
    }
  }
  return updates;
}

export function resultStopReason(msg: SDKMessage): StopReason | null {
  if (msg.type !== 'result') return null;
  const subtype = (msg as any).subtype;
  if (subtype === 'success') return 'end_turn';
  if (subtype === 'error_max_turns') return 'max_turn_requests';
  return 'end_turn';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/sdkMessageToAcp.test.ts`
Expected: PASS (6 tests). If `SessionUpdate` requires more fields (e.g. `tool_call` mandatory props), grep `ToolCall` in `types.gen.d.ts` and add them, then re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/acpAgent/sdkMessageToAcp.ts packages/happy-cli/src/acpAgent/sdkMessageToAcp.test.ts
git commit -m "feat(cli): translate Claude SDK messages into ACP session updates"
```

---

## Phase 2 — Engine taps (additive edits to existing files)

### Task 3: Add optional taps to the Session object

**Files:**
- Modify: `packages/happy-cli/src/claude/session.ts`

**Interfaces:**
- Produces on `Session`: three optional fields readable by the launcher/permission handler —
  - `onAgentSdkMessage?: (message: SDKMessage) => void`
  - `onPermissionRequest?: (req: { id: string; toolName: string; input: unknown }) => void`
  - `onPermissionResolved?: (id: string) => void`

- [ ] **Step 1: Read the current constructor**

Run: `sed -n '1,80p' packages/happy-cli/src/claude/session.ts` — confirm the options object shape and field declarations (see design doc; fields at lines 8–34, constructor 36–76).

- [ ] **Step 2: Add the fields and constructor options**

Add an import at the top (near line 3):
```ts
import type { SDKMessage } from '@/claude/sdk';
```
Add field declarations alongside the other `readonly` fields (after `jsRuntime`, ~line 25):
```ts
readonly onAgentSdkMessage?: (message: SDKMessage) => void;
readonly onPermissionRequest?: (req: { id: string; toolName: string; input: unknown }) => void;
readonly onPermissionResolved?: (id: string) => void;
```
Add to the constructor's options type and assign them (mirror the existing `onModeChange` handling):
```ts
// in the options parameter type:
onAgentSdkMessage?: (message: SDKMessage) => void;
onPermissionRequest?: (req: { id: string; toolName: string; input: unknown }) => void;
onPermissionResolved?: (id: string) => void;
// in the constructor body:
this.onAgentSdkMessage = opts.onAgentSdkMessage;
this.onPermissionRequest = opts.onPermissionRequest;
this.onPermissionResolved = opts.onPermissionResolved;
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no new errors (existing callers pass no new options; all three are optional).

- [ ] **Step 4: Commit**

```bash
git add packages/happy-cli/src/claude/session.ts
git commit -m "feat(cli): add optional ACP taps to Session (sdk message + permission observers)"
```

---

### Task 4: Fire the SDK-message tap from the remote launcher

**Files:**
- Modify: `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` (its `onMessage`, ~line 137)

- [ ] **Step 1: Locate the onMessage sink**

Run: `sed -n '130,175p' packages/happy-cli/src/claude/claudeRemoteLauncher.ts` — find the `onMessage(message: SDKMessage)` body that formats for Ink and forwards to the app.

- [ ] **Step 2: Add the tap as the first line of onMessage**

Insert at the very top of the `onMessage` function body (before any TTY/Ink formatting), so the editor gets every SDK message regardless of TTY:
```ts
session.onAgentSdkMessage?.(message);
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no new errors (`session` is in scope; the field is optional).

- [ ] **Step 4: Commit**

```bash
git add packages/happy-cli/src/claude/claudeRemoteLauncher.ts
git commit -m "feat(cli): forward SDK messages to the ACP tap in remote launcher"
```

---

### Task 5: Permission handler observer hooks + external resolution

**Files:**
- Modify: `packages/happy-cli/src/claude/utils/permissionHandler.ts`

**Background (verified):** `PermissionHandler` is constructed with `(session)`; `handlePermissionRequest` (~line 196) creates a promise stored in `pendingRequests` keyed by `toolUseID` and writes `AgentState.requests`; the `permission` RPC handler (`setupClientHandler`, ~line 344) resolves it and moves it to `completedRequests`. We add: (a) fire `session.onPermissionRequest` when a request goes pending, (b) fire `session.onPermissionResolved` whenever any request resolves/cancels, (c) a public `resolveExternally(id, response)` the ACP bridge calls when the editor answers.

**Interfaces:**
- Produces on `PermissionHandler`: `resolveExternally(id: string, response: { approved: boolean; mode?: PermissionMode; allowTools?: string[] }): boolean` (returns `false` if no such pending request).

- [ ] **Step 1: Read the pending-request creation and the RPC resolve path**

Run: `sed -n '196,260p' packages/happy-cli/src/claude/utils/permissionHandler.ts` and `sed -n '340,390p' packages/happy-cli/src/claude/utils/permissionHandler.ts` — note the exact `pendingRequests` value shape (`{ resolve, reject, toolName, input }`) and how the RPC handler builds the `PermissionResult` and calls `pending.resolve(...)`.

- [ ] **Step 2: Fire the request-pending hook**

In `handlePermissionRequest`, immediately after the request is stored in `pendingRequests` and written to agent state, add:
```ts
this.session.onPermissionRequest?.({ id, toolName, input });
```
(Use the same `id`/`toolName`/`input` variables already in scope.)

- [ ] **Step 3: Fire the resolved hook and add resolveExternally**

Find the private routine the RPC handler uses to resolve a request (it looks up `pendingRequests.get(id)`, deletes it, calls `pending.resolve(result)`, updates agent state). Extract/confirm a single method that both the RPC handler and the editor path can call. Then add a public method:
```ts
resolveExternally(id: string, response: { approved: boolean; mode?: PermissionMode; allowTools?: string[] }): boolean {
  const pending = this.pendingRequests.get(id);
  if (!pending) return false;
  // Reuse the SAME resolution path the 'permission' RPC uses:
  this.handlePermissionResponse({ id, approved: response.approved, mode: response.mode, allowTools: response.allowTools });
  return true;
}
```
If `handlePermissionResponse` is not already a method (it is referenced in the design as `permissionHandler.ts:71`), call whatever method the RPC handler delegates to — do NOT duplicate the resolve/agent-state logic. In every place a request leaves `pendingRequests` (RPC resolve, abort, `reset`), add:
```ts
this.session.onPermissionResolved?.(id);
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Run existing permission tests**

Run: `cd packages/happy-cli && npx vitest run src/claude/utils/permissionHandler`
Expected: existing tests still PASS (hooks are optional; no behavior change when unset). If no test file exists, skip.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/claude/utils/permissionHandler.ts
git commit -m "feat(cli): permission handler observer hooks + external resolution for ACP"
```

---

## Phase 3 — ACP agent server (bootstrap + handshake + walking skeleton)

### Task 6: The ACP Agent implementation skeleton

**Files:**
- Create: `packages/happy-cli/src/acpAgent/HappyAcpAgent.ts`

**Interfaces:**
- Consumes: `AgentSideConnection`, and the `Agent` interface, from `@agentclientprotocol/sdk`; `parsePromptBlocks` (Task 1); `sdkMessageToUpdates`/`resultStopReason` (Task 2); `Credentials` from `@/persistence`.
- Produces: `class HappyAcpAgent implements Agent` with a constructor `(connection: AgentSideConnection, credentials: Credentials)`. This task implements `initialize`, `authenticate`, `cancel` stubs; `newSession`/`prompt` land in Task 7–8.

- [ ] **Step 1: Write the class with initialize/authenticate**

```ts
// HappyAcpAgent.ts
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
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no errors. If `agentCapabilities` fields differ, grep `AgentCapabilities`/`PromptCapabilities` in `types.gen.d.ts` and adjust. Remove unused-import errors by keeping only what compiles now (add the rest back as tasks use them).

- [ ] **Step 3: Commit**

```bash
git add packages/happy-cli/src/acpAgent/HappyAcpAgent.ts
git commit -m "feat(cli): ACP Agent skeleton (initialize/authenticate)"
```

---

### Task 7: newSession — bootstrap the headless Claude engine

**Files:**
- Modify: `packages/happy-cli/src/acpAgent/HappyAcpAgent.ts`
- Create: `packages/happy-cli/src/acpAgent/engine.ts`

**Background:** Bootstrap mirrors `runClaude` (`src/claude/runClaude.ts`) and `runAcp` (`src/agent/acp/runAcp.ts`), assembled headless. Reuse the same helpers: `ApiClient.create`, `getOrCreateMachine`, `createSessionMetadata`, `getOrCreateSession`, `sessionSyncClient`, `startHappyServer`, `startHookServer` + `generateHookSettingsFile`, `new MessageQueue2<EnhancedMode>`, `new Session`, and `claudeRemoteLauncher`. The engine runs the launcher **without awaiting** (it lives for the session's lifetime) and exposes the `messageQueue` + `Session` so `prompt` can push and observe turns.

**Interfaces:**
- Produces: `startEngine(opts: { credentials: Credentials; cwd: string; onAgentSdkMessage: (m: SDKMessage) => void; onPermissionRequest: (r: { id: string; toolName: string; input: unknown }) => void; onPermissionResolved: (id: string) => void }): Promise<Engine>` where
  ```ts
  interface Engine {
    happySessionId: string;              // Happy server session id
    push(text: string, attachments?: PendingAttachment[]): void;
    permissionHandler: PermissionHandler;   // for resolveExternally / mode
    setPermissionMode(mode: PermissionMode): void;
    abort(): Promise<void>;
    dispose(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write `engine.ts` bootstrap**

```ts
// engine.ts
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
import { generateHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { hashObject } from '@/utils/deterministicJson';
import { logger } from '@/ui/logger';
import type { EnhancedMode, PermissionMode } from '@/claude/loop';
import type { SDKMessage } from '@/claude/sdk';

export interface Engine {
  happySessionId: string;
  push(text: string, attachments?: PendingAttachment[]): void;
  setPermissionMode(mode: PermissionMode): void;
  abort(): Promise<void>;
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
  if (!settings.machineId) throw new Error('machineId not set; run `happy auth` first');
  await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });

  const { state, metadata } = createSessionMetadata({
    flavor: 'claude',
    machineId: settings.machineId,
    startedBy: 'terminal',
    sandbox: settings.sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
  if (!response) throw new Error('failed to create Happy session (offline?)');
  const client = api.sessionSyncClient(response);

  const happyServer = await startHappyServer(client);
  const hookServer = await startHookServer({ /* mirror runClaude.ts:462 args */ } as any);
  const hookSettingsPath = generateHookSettingsFile(hookServer.port);

  let currentPermissionMode: PermissionMode = 'default';
  const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject(mode));
  const enhancedMode = (): EnhancedMode => ({ permissionMode: currentPermissionMode } as EnhancedMode);

  const session = new Session({
    api,
    client,
    path: opts.cwd,
    sessionId: null,
    mcpServers: { happy: { type: 'http', url: happyServer.url } },
    logPath: logger.logFilePath,
    messageQueue,
    allowedTools: happyServer.toolNames.map((t) => `mcp__happy__${t}`),
    onModeChange: () => {},       // headless: never switch to local
    onAbort: () => {},
    hookSettingsPath,
    onAgentSdkMessage: opts.onAgentSdkMessage,
    onPermissionRequest: opts.onPermissionRequest,
    onPermissionResolved: opts.onPermissionResolved,
  } as any);

  // Run the launcher for the session lifetime; do NOT await.
  const launcherDone = claudeRemoteLauncher(session).catch((e) => {
    logger.debug('[acp-agent] launcher exited', e);
  });

  const keepAlive = setInterval(() => client.keepAlive(session.thinking, 'remote'), 2000);

  return {
    happySessionId: response.id,
    push: (text, attachments) => messageQueue.push(text, enhancedMode(), attachments),
    setPermissionMode: (mode) => { currentPermissionMode = mode; },
    abort: async () => { messageQueue.reset(); },
    dispose: async () => {
      clearInterval(keepAlive);
      messageQueue.close();
      await launcherDone;
      happyServer.stop();
      await client.flush();
      await client.close();
    },
  };
}
```

- [ ] **Step 2: Fill the `startHookServer` args**

Run: `sed -n '462,495p' packages/happy-cli/src/claude/runClaude.ts` — copy the exact options object passed to `startHookServer({ ... })` into `engine.ts` (replace the `{} as any` placeholder). Do not invent fields; use exactly what `runClaude` passes.

- [ ] **Step 3: Wire newSession in HappyAcpAgent**

Add an engine map and implement `newSession`:
```ts
// in HappyAcpAgent.ts
import { startEngine, type Engine } from './engine';
import { sdkMessageToUpdates, resultStopReason } from './sdkMessageToAcp';
// field:
private engine: Engine | null = null;
private acpSessionId: string | null = null;
private turnResolvers: Array<(r: import('@agentclientprotocol/sdk').StopReason) => void> = [];

async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
  if (this.engine) throw new Error('this agent supports a single session per process');
  const sessionId = `acp-${Date.now().toString(36)}`;
  this.acpSessionId = sessionId;
  this.engine = await startEngine({
    credentials: this.credentials,
    cwd: params.cwd,
    onAgentSdkMessage: (m) => this.onSdkMessage(m),
    onPermissionRequest: (r) => { /* Task 9 */ },
    onPermissionResolved: (id) => { /* Task 9 */ },
  });
  return { sessionId };
}

private onSdkMessage(m: import('@/claude/sdk').SDKMessage) {
  if (!this.acpSessionId) return;
  for (const update of sdkMessageToUpdates(m)) {
    void this.connection.sessionUpdate({ sessionId: this.acpSessionId, update });
  }
  const stop = resultStopReason(m);
  if (stop) {
    const resolver = this.turnResolvers.shift();
    resolver?.(stop);
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no errors. Fix any `createSessionMetadata` / `startHookServer` / `Session` option mismatches by matching the exact call sites in `runClaude.ts`/`runAcp.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/acpAgent/engine.ts packages/happy-cli/src/acpAgent/HappyAcpAgent.ts
git commit -m "feat(cli): headless Claude engine bootstrap + ACP newSession"
```

---

### Task 8: prompt — push to the queue and await the turn

**Files:**
- Modify: `packages/happy-cli/src/acpAgent/HappyAcpAgent.ts`

- [ ] **Step 1: Implement prompt**

```ts
async prompt(params: PromptRequest): Promise<PromptResponse> {
  if (!this.engine) throw new Error('no active session');
  const { text, attachments } = parsePromptBlocks(params.prompt);
  const stopReason = await new Promise<import('@agentclientprotocol/sdk').StopReason>((resolve) => {
    this.turnResolvers.push(resolve);
    this.engine!.push(text, attachments);
  });
  return { stopReason };
}
```
Add the import: `import { parsePromptBlocks } from './contentBlocks';`

- [ ] **Step 2: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/happy-cli/src/acpAgent/HappyAcpAgent.ts
git commit -m "feat(cli): ACP prompt pushes to the Claude queue and awaits turn end"
```

---

### Task 9: runAcpAgent entrypoint + subcommand

**Files:**
- Create: `packages/happy-cli/src/acpAgent/runAcpAgent.ts`
- Modify: `packages/happy-cli/src/index.ts`

**Interfaces:**
- Consumes: `AgentSideConnection`, `ndJsonStream` from `@agentclientprotocol/sdk`; `HappyAcpAgent` (Task 6); `Credentials`.
- Produces: `runAcpAgent(opts: { credentials: Credentials }): Promise<void>`.

- [ ] **Step 1: Write the stdio wiring**

```ts
// runAcpAgent.ts
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { HappyAcpAgent } from './HappyAcpAgent';
import { nodeToWebStreams } from './stdioStreams';

export async function runAcpAgent(opts: { credentials: Credentials }): Promise<void> {
  // stdout = JSON-RPC out (writable), stdin = JSON-RPC in (readable)
  const { writable, readable } = nodeToWebStreams(process.stdout, process.stdin);
  const stream = ndJsonStream(writable, readable);
  const connection = new AgentSideConnection((conn) => new HappyAcpAgent(conn, opts.credentials), stream);
  await new Promise<void>((resolve) => {
    connection.signal.addEventListener('abort', () => resolve());
  });
}
```

- [ ] **Step 2: Extract `nodeToWebStreams` for reuse**

Create `packages/happy-cli/src/acpAgent/stdioStreams.ts` by copying the `nodeToWebStreams` helper from `packages/happy-cli/src/agent/acp/AcpBackend.ts:217-270` (it converts a Node `Writable`+`Readable` into `{ writable, readable }` web streams). Export it. (Do not re-import from AcpBackend — it is not exported there; copy the small helper and note the source in a comment. Both files MIT.)

- [ ] **Step 3: Add the subcommand branch to index.ts**

After the existing `else if (subcommand === 'acp') { ... }` block (ends ~line 399), add:
```ts
} else if (subcommand === 'acp-agent') {
  try {
    const { runAcpAgent } = await import('@/acpAgent/runAcpAgent');
    const { credentials } = await authAndSetupMachineIfNeeded();
    await runAcpAgent({ credentials });
  } catch (error) {
    // NEVER write errors to stdout in this mode — stderr only.
    process.stderr.write(`acp-agent error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  return;
```

- [ ] **Step 4: Typecheck + build**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/acpAgent/runAcpAgent.ts packages/happy-cli/src/acpAgent/stdioStreams.ts packages/happy-cli/src/index.ts
git commit -m "feat(cli): happy acp-agent subcommand + stdio AgentSideConnection"
```

---

### Task 10: Headless integration test (handshake + prompt round-trip)

**Files:**
- Create: `packages/happy-cli/src/acpAgent/runAcpAgent.integration.test.ts`

**Background:** Drive the ACP agent as a client over an in-memory stream: send `initialize` and assert the response; assert nothing but valid JSON reaches the writable. This validates the stdio contract without a live Claude/server (mock the engine).

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

// Mock the engine so newSession/prompt don't touch the network.
vi.mock('./engine', () => ({
  startEngine: vi.fn(async () => ({
    happySessionId: 'happy_test',
    push: vi.fn(),
    setPermissionMode: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
  })),
}));

describe('HappyAcpAgent handshake', () => {
  it('responds to initialize with protocolVersion 1', async () => {
    const { HappyAcpAgent } = await import('./HappyAcpAgent');
    const { AgentSideConnection } = await import('@agentclientprotocol/sdk');
    // Build a paired in-memory duplex (two TransformStreams crossed).
    const a = new TransformStream<Uint8Array, Uint8Array>();
    const b = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(a.writable, b.readable);
    const clientStream = ndJsonStream(b.writable, a.readable);
    new AgentSideConnection((conn: any) => new HappyAcpAgent(conn, {} as any), agentStream);
    const client = new ClientSideConnection(() => ({} as any), clientStream);
    const res = await client.initialize({ protocolVersion: 1, clientCapabilities: {} } as any);
    expect(res.protocolVersion).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/runAcpAgent.integration.test.ts`
Expected: PASS. If the paired-stream plumbing needs adjustment, follow the pattern in `packages/happy-cli/src/agent/acp/AcpBackend.test.ts` / `runAcp.test.ts` which already exercise ndJsonStream in tests.

- [ ] **Step 3: Commit**

```bash
git add packages/happy-cli/src/acpAgent/runAcpAgent.integration.test.ts
git commit -m "test(cli): ACP agent initialize handshake over in-memory stream"
```

---

## Phase 4 — Permission bridge, modes, cancel

### Task 11: Bridge permissions to the editor

**Files:**
- Modify: `packages/happy-cli/src/acpAgent/HappyAcpAgent.ts`

**Background:** `onPermissionRequest` fires when Claude gates a tool. Call `connection.requestPermission(...)` toward the editor; when it answers, call `engine.permissionHandler`-equivalent via a resolver the engine exposes. First-answer-wins is already enforced by `resolveExternally` returning false once resolved. On `onPermissionResolved` (phone answered first), drop our record so a late editor answer is ignored.

- [ ] **Step 1: Expose external resolution from the engine**

In `engine.ts`, capture the `PermissionHandler` the launcher creates. Since the launcher constructs it internally, add to `Session` a resolver setter is unnecessary — instead expose resolution through the observer: have the engine keep a `resolvePermission(id, approved)` that calls into the handler. Simplest correct wiring: in `engine.ts`, pass `onPermissionResolved` through (already done) and add `resolvePermission` to the `Engine` interface that calls a handler reference. To get that reference, add an optional `onPermissionHandlerReady?: (h: PermissionHandler) => void` tap to `Session` (Task 3 pattern) and have `claudeRemoteLauncher` call it right after `new PermissionHandler(session)` (~line 103). Store it in the engine and implement:
```ts
resolvePermission(id: string, approved: boolean) { this.permissionHandlerRef?.resolveExternally(id, { approved }); }
```

- [ ] **Step 2: Map and forward the request in HappyAcpAgent**

```ts
onPermissionRequest: (r) => {
  if (!this.acpSessionId) return;
  const options = [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ];
  void this.connection.requestPermission({
    sessionId: this.acpSessionId,
    toolCall: { toolCallId: r.id, title: r.toolName, rawInput: r.input, status: 'pending' } as any,
    options: options as any,
  }).then((resp) => {
    const outcome = (resp as any).outcome;
    if (outcome?.outcome === 'selected') {
      this.engine?.resolvePermission(r.id, outcome.optionId === 'allow');
    }
  }).catch(() => { /* editor cancelled or connection closed */ });
},
onPermissionResolved: (_id) => { /* first-wins handled by resolveExternally returning false */ },
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd packages/happy-cli && npx tsc --noEmit`
```bash
git add packages/happy-cli/src/acpAgent/HappyAcpAgent.ts packages/happy-cli/src/acpAgent/engine.ts packages/happy-cli/src/claude/session.ts packages/happy-cli/src/claude/claudeRemoteLauncher.ts
git commit -m "feat(cli): bridge Claude permission prompts to the ACP editor (first-answer-wins)"
```

---

### Task 12: setSessionMode + cancel

**Files:**
- Modify: `packages/happy-cli/src/acpAgent/HappyAcpAgent.ts`

- [ ] **Step 1: Implement setSessionMode and cancel**

```ts
async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
  const map: Record<string, import('@/claude/loop').PermissionMode> = {
    default: 'default', acceptEdits: 'acceptEdits', bypassPermissions: 'bypassPermissions', plan: 'plan',
  };
  const mode = map[(params as any).modeId] ?? 'default';
  this.engine?.setPermissionMode(mode);
  return;
}

async cancel(_params: CancelNotification): Promise<void> {
  await this.engine?.abort();
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd packages/happy-cli && npx tsc --noEmit`
```bash
git add packages/happy-cli/src/acpAgent/HappyAcpAgent.ts
git commit -m "feat(cli): ACP setSessionMode + cancel wiring"
```

---

## Phase 5 — Verification

### Task 13: Full typecheck, build, and test sweep

- [ ] **Step 1: Typecheck the package**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Run the acpAgent test suite**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent`
Expected: all PASS.

- [ ] **Step 3: Run existing ACP + claude tests (regression)**

Run: `cd packages/happy-cli && npx vitest run src/agent/acp src/claude/utils/permissionHandler`
Expected: no regressions.

- [ ] **Step 4: Build**

Run: `cd packages/happy-cli && npm run build` (or the package's build script — check `package.json`)
Expected: builds; `dist/index.mjs` present.

- [ ] **Step 5: Manual smoke (no editor) — verify stdout cleanliness**

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | node packages/happy-cli/bin/happy.mjs acp-agent 2>/dev/null | head -1`
Expected: a single valid JSON-RPC response object with `"protocolVersion":1` and nothing else on stdout.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A && git commit -m "chore(cli): acp-agent verification fixes"
```

---

### Task 14: End-to-end acceptance (human, documented)

Not automated. Record steps in the PR description:

1. Point Zed `agent_servers` at a custom command: `node <abs path>/packages/happy-cli/bin/happy.mjs acp-agent`.
2. Open a project in Zed; start a thread in the agent panel; send a prompt — assert streamed text + tool calls render.
3. On the phone (Happy app), confirm the same session appears and shows the thread.
4. Send a prompt from the phone — assert Zed's panel advances (unsolicited `session/update`s).
5. Return to Zed, send another prompt — assert it continues with full context, no restart.
6. Trigger a tool needing approval; assert the prompt appears on whichever client is active and either can approve.

---

## Self-Review notes

- **Spec coverage:** two-faces topology (Tasks 7, 9), soft-floor/rest-only (Task 8 turn serialization via existing queue), permission bridge session-owned (Tasks 5, 11), headless stdout (Global Constraints, Tasks 9, 13.5), integration map inbound/outbound (Tasks 6–12). Out-of-scope items (`loadSession`, hard lock, mid-turn, non-Claude) are intentionally absent.
- **Known iteration points** flagged inline for the implementer to confirm against the installed SDK/codebase rather than guess: exact `ContentBlock`/`SessionUpdate`/`AgentCapabilities`/`PermissionOption` field names (grep `types.gen.d.ts`), `startHookServer` args (copy from `runClaude.ts:462`), and `PermissionHandler` internal resolve method name (`permissionHandler.ts`). These are real-symbol confirmations, not design gaps.
- **Type consistency:** `Engine` interface (Task 7) gains `permissionHandler`/`resolvePermission` in Task 11 — update the interface there. `turnResolvers` FIFO assumes one in-flight turn (true under queue serialization).
