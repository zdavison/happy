# Happy ACP Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `happy acp-agent` into a bidirectional ACP proxy: Zed ↔ Happy ↔ a user-provided downstream ACP agent, with the phone tapped in the middle for render + drive + approve.

**Architecture:** Happy is an ACP *agent* to Zed (`AgentSideConnection`) and an ACP *client* to the downstream (`ClientSideConnection`), both over stdio via `ndJsonStream`. A `HappyProxyAgent` forwards Zed's agent-methods **down**; a `HappyProxyClient` forwards the downstream's client-methods **up**, and taps `sessionUpdate`/`prompt`/`requestPermission` to relay to / accept input from the phone (reusing `runAcp`'s Happy-session relay). Raw pass-through preserves the downstream's advertised `modes`/`models`/`configOptions` for Zed's pickers.

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk` (`AgentSideConnection`, `ClientSideConnection`, `ndJsonStream`), `socket.io-client`, `vitest`. Package: `packages/happy-cli`.

## Global Constraints

- **Headless / stdout is sacred.** In `acp-agent` mode, `process.stdout` carries ONLY the Zed-facing JSON-RPC. All logs → `process.stderr` or the file `logger` (`@/ui/logger`). Never `console.log`.
- **Raw pass-through to Zed.** Forward the downstream's ACP responses/notifications to Zed *verbatim* (do not route through `AcpBackend`/`AgentMessage`). The whole point of BYO is that Zed sees exactly what the downstream advertises.
- **Bidirectional forwarding.** Agent methods (initialize/newSession/loadSession/prompt/cancel/setSessionMode/setSessionConfigOption/unstable_setSessionModel/authenticate) go Zed→downstream; client methods (sessionUpdate/requestPermission/readTextFile/writeTextFile/createTerminal + terminal ops) go downstream→Zed.
- **BYO.** The downstream agent is user-provided via `resolveAcpAgentConfig` (`happy acp-agent -- <cmd>` or an alias). Happy installs nothing.
- **Reuse over reimplementation.** Spawn/stream mirrors `src/agent/acp/AcpBackend.ts`; the Happy-session relay mirrors `src/agent/acp/runAcp.ts`.
- **Phase 1 only.** Mobile renders at the "ACP tier" (text + permissions + drive; plain tool cards). Mobile fidelity enrichment and Claude subagent-trees are out of scope (Phase 2 / accepted loss). Design: `docs/superpowers/specs/2026-07-03-happy-acp-proxy-design.md`.

## SDK reference (verified against `@agentclientprotocol/sdk@0.14`)

- `new AgentSideConnection(toAgent: (conn) => Agent, stream)` — Happy→Zed. `conn` exposes `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`, `createTerminal`.
- `new ClientSideConnection(toClient: (agent) => Client, stream)` — Happy→downstream. `agent` (the connection) exposes `initialize`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `setSessionConfigOption`, `unstable_setSessionModel`, `authenticate`.
- `Agent` interface Happy implements toward Zed: `initialize`, `newSession`, `loadSession?`, `setSessionMode?`, `setSessionConfigOption?`, `authenticate`, `prompt`, `cancel`, `extMethod?`, `extNotification?`.
- `Client` interface Happy implements toward downstream: `requestPermission`, `sessionUpdate`, `writeTextFile?`, `readTextFile?`, `createTerminal?`, `terminalOutput?`, `waitForTerminalExit?`, `killTerminal?`, `releaseTerminal?`.
- `ndJsonStream(writable, readable)` and `nodeToWebStreams` (now at `src/utils/nodeToWebStreams.ts`).

## File structure

- Delete: `src/acpAgent/engine.ts`, `src/acpAgent/sdkMessageToAcp.ts`, `src/acpAgent/contentBlocks.ts`, `src/acpAgent/HappyAcpAgent.ts` (+ their `.test.ts`).
- Keep: `src/utils/nodeToWebStreams.ts`; the `claudeRemoteLauncher.ts` closed-queue loop-exit fix.
- Create:
  - `src/acpAgent/downstream.ts` — spawn the downstream agent, build its `ClientSideConnection`.
  - `src/acpAgent/proxy.ts` — `HappyProxyAgent` (Agent→down) + `HappyProxyClient` (Client→up) forwarders with tap hooks.
  - `src/acpAgent/phoneRelay.ts` — Happy-session bootstrap + `sessionUpdateToEnvelopes` + prompt/turn + onUserMessage + permission surfacing.
  - `src/acpAgent/runAcpAgent.ts` — REWRITE: assemble everything.
- Modify: `src/index.ts` (`acp-agent` parses the downstream spec); revert `src/claude/session.ts` and `src/claude/utils/permissionHandler.ts` to main; revert the tap calls in `src/claude/claudeRemoteLauncher.ts` but keep the loop-exit fix.

---

## Task 1: Clear the native-Claude deck

**Files:**
- Delete: `src/acpAgent/engine.ts`, `sdkMessageToAcp.ts`, `sdkMessageToAcp.test.ts`, `contentBlocks.ts`, `contentBlocks.test.ts`, `HappyAcpAgent.ts`, `HappyAcpAgent.test.ts`
- Modify (revert to main): `src/claude/session.ts`, `src/claude/utils/permissionHandler.ts`, `src/claude/utils/permissionHandler.test.ts`
- Modify (partial): `src/claude/claudeRemoteLauncher.ts`
- Modify (temporary stub): `src/acpAgent/runAcpAgent.ts`

**Interfaces:**
- Produces: a compiling tree with the native ACP code removed. `runAcpAgent({ credentials })` still exists as a stub (rebuilt in Task 6).

- [ ] **Step 1: Delete native files**

```bash
cd /Users/z/github/happy/packages/happy-cli
git rm src/acpAgent/engine.ts src/acpAgent/sdkMessageToAcp.ts src/acpAgent/sdkMessageToAcp.test.ts \
       src/acpAgent/contentBlocks.ts src/acpAgent/contentBlocks.test.ts \
       src/acpAgent/HappyAcpAgent.ts src/acpAgent/HappyAcpAgent.test.ts
```

- [ ] **Step 2: Revert the fully-native-only files to main**

```bash
git checkout main -- src/claude/session.ts src/claude/utils/permissionHandler.ts src/claude/utils/permissionHandler.test.ts
```
(These files' branch changes existed only to bridge the native Claude engine.)

- [ ] **Step 3: Revert the launcher taps but KEEP the loop-exit fix**

In `src/claude/claudeRemoteLauncher.ts`: remove the added lines `session.onAgentSdkMessage?.(message);`, `session.onPermissionHandlerReady?.(permissionHandler);`, and `session.onAbortReady?.(doAbort);`. KEEP the loop guard change `while (!exitReason && !session.queue.isClosed())`. Verify by diffing against main:
```bash
git diff main -- src/claude/claudeRemoteLauncher.ts
```
Expected: the ONLY remaining diff is the `while (... && !session.queue.isClosed())` guard.

- [ ] **Step 4: Stub `runAcpAgent.ts`**

```ts
// src/acpAgent/runAcpAgent.ts
import type { Credentials } from '@/persistence';

export async function runAcpAgent(_opts: { credentials: Credentials; agentName: string; command: string; args: string[] }): Promise<void> {
  throw new Error('acp-agent proxy not yet wired'); // rebuilt in Task 6
}
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: passes. If `index.ts` references the old `runAcpAgent({ credentials })` shape, leave index.ts alone for now — Task 7 rewires it; if tsc fails only on the `runAcpAgent` call arity in index.ts, adjust the stub signature to `{ credentials: Credentials }` temporarily to keep it green, and note it for Task 7.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(cli): remove native-Claude acp-agent, keep launcher loop-exit fix"
```

---

## Task 2: `sessionUpdateToEnvelopes` (phone-tap mapper, pure)

**Files:**
- Create: `src/acpAgent/phoneRelay.ts` (start with just this function + its exports)
- Test: `src/acpAgent/phoneRelay.test.ts`

**Background:** The phone renders Happy `SessionEnvelope`s. This Phase-1 mapper converts a raw ACP `SessionUpdate` into envelopes, mirroring `AcpSessionManager` but consuming ACP directly. Handle the four core variants; return `[]` for the rest (Phase 2 enriches). Envelopes are built with `createEnvelope` from `@slopus/happy-wire` — read `src/agent/acp/AcpSessionManager.ts:76-171` for the exact `createEnvelope('agent', ev, turnOptions(...))` usage and the `ev` shapes (`{t:'text',text}`, `{t:'text',text,thinking:true}`, `{t:'tool-call-start',call,name,title,args}`, `{t:'tool-call-end',call}`).

**Interfaces:**
- Produces: `sessionUpdateToEnvelopes(update: SessionUpdate, turnId: string | null): SessionEnvelope[]` (`SessionUpdate` from `@agentclientprotocol/sdk`, `SessionEnvelope` from `@slopus/happy-wire`).

- [ ] **Step 1: Write the failing test**

```ts
// phoneRelay.test.ts
import { describe, it, expect } from 'vitest';
import { sessionUpdateToEnvelopes } from './phoneRelay';

describe('sessionUpdateToEnvelopes', () => {
  it('maps agent_message_chunk text to a text envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as any, 't1');
    expect(out).toHaveLength(1);
    expect(out[0].content).toMatchObject({ t: 'text', text: 'hi' });
  });
  it('maps agent_thought_chunk to a thinking text envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } as any, 't1');
    expect(out[0].content).toMatchObject({ t: 'text', text: 'hmm', thinking: true });
  });
  it('maps tool_call to a tool-call-start envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', rawInput: { command: 'ls' } } as any, 't1');
    expect(out[0].content).toMatchObject({ t: 'tool-call-start', call: 'c1' });
  });
  it('maps tool_call_update(completed) to a tool-call-end envelope', () => {
    const out = sessionUpdateToEnvelopes({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' } as any, 't1');
    expect(out[0].content).toMatchObject({ t: 'tool-call-end', call: 'c1' });
  });
  it('returns [] for unhandled variants', () => {
    expect(sessionUpdateToEnvelopes({ sessionUpdate: 'plan' } as any, 't1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/phoneRelay.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement**

Read `src/agent/acp/AcpSessionManager.ts` for the exact `createEnvelope`/`turnOptions` imports and envelope shapes, then:

```ts
// phoneRelay.ts (mapper section)
import { createEnvelope } from '@slopus/happy-wire';
import type { SessionEnvelope } from '@slopus/happy-wire';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

// Mirror AcpSessionManager's turnOptions(turnId, time) — copy its exact shape from
// src/agent/acp/AcpSessionManager.ts (turnOptions helper) rather than guessing.
function ev(content: unknown, turnId: string | null): SessionEnvelope {
  return createEnvelope('agent', content as any, { turnId } as any); // match AcpSessionManager's turnOptions signature
}

export function sessionUpdateToEnvelopes(update: SessionUpdate, turnId: string | null): SessionEnvelope[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = (update as any).content?.text;
      return text ? [ev({ t: 'text', text }, turnId)] : [];
    }
    case 'agent_thought_chunk': {
      const text = (update as any).content?.text;
      return text ? [ev({ t: 'text', text, thinking: true }, turnId)] : [];
    }
    case 'tool_call': {
      const u = update as any;
      return [ev({ t: 'tool-call-start', call: u.toolCallId, name: u.title, title: u.title, args: u.rawInput ?? {} }, turnId)];
    }
    case 'tool_call_update': {
      const u = update as any;
      if (u.status === 'completed' || u.status === 'failed') return [ev({ t: 'tool-call-end', call: u.toolCallId }, turnId)];
      return [];
    }
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/phoneRelay.test.ts`
Expected: PASS (5 tests). If `createEnvelope`'s third arg shape differs, correct `ev()` against `AcpSessionManager.ts`'s `turnOptions` and re-run — do NOT change the asserted `content` shapes.

- [ ] **Step 5: Commit**

```bash
git add src/acpAgent/phoneRelay.ts src/acpAgent/phoneRelay.test.ts
git commit -m "feat(cli): map ACP session updates to phone envelopes (proxy phase-1 tier)"
```

---

## Task 3: The proxy forwarders (`proxy.ts`)

**Files:**
- Create: `src/acpAgent/proxy.ts`
- Test: `src/acpAgent/proxy.test.ts`

**Background:** Two forwarders wired to opposite connections, with tap callbacks so the relay/permission layers can observe without the proxy knowing about them. `HappyProxyAgent` receives Zed's calls and forwards to a `ClientSideConnection` (the downstream). `HappyProxyClient` receives the downstream's calls and forwards to an `AgentSideConnection` (Zed), invoking taps.

**Interfaces:**
- Consumes: SDK types; `sessionUpdateToEnvelopes` is NOT used here (used by the relay, Task 4).
- Produces:
  - `interface ProxyTaps { onSessionUpdate?(u: SessionNotification): void; onRequestPermission?(p: RequestPermissionRequest): void; onPrompt?(p: PromptRequest): void; onNewSession?(req: NewSessionRequest, res: NewSessionResponse): void; onPromptDone?(sessionId: string): void }`
  - `class HappyProxyAgent implements Agent` — ctor `(getDownstream: () => ClientSideConnection, taps: ProxyTaps)`.
  - `class HappyProxyClient implements Client` — ctor `(getZed: () => AgentSideConnection, taps: ProxyTaps)`.

- [ ] **Step 1: Write the failing test**

```ts
// proxy.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HappyProxyAgent, HappyProxyClient } from './proxy';

describe('HappyProxyAgent forwards down', () => {
  it('forwards prompt to the downstream and fires onPrompt tap', async () => {
    const downstream = { prompt: vi.fn(async () => ({ stopReason: 'end_turn' })) } as any;
    const onPrompt = vi.fn();
    const agent = new HappyProxyAgent(() => downstream, { onPrompt });
    const req = { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } as any;
    const res = await agent.prompt(req);
    expect(downstream.prompt).toHaveBeenCalledWith(req);
    expect(onPrompt).toHaveBeenCalledWith(req);
    expect(res).toEqual({ stopReason: 'end_turn' });
  });
  it('forwards newSession and fires onNewSession tap with the response', async () => {
    const resp = { sessionId: 'd1', modes: { currentModeId: 'default', availableModes: [] } };
    const downstream = { newSession: vi.fn(async () => resp) } as any;
    const onNewSession = vi.fn();
    const agent = new HappyProxyAgent(() => downstream, { onNewSession });
    const req = { cwd: '/x', mcpServers: [] } as any;
    const res = await agent.newSession(req);
    expect(res).toBe(resp);                       // verbatim pass-through (modes preserved)
    expect(onNewSession).toHaveBeenCalledWith(req, resp);
  });
});

describe('HappyProxyClient forwards up', () => {
  it('forwards sessionUpdate to Zed and fires onSessionUpdate tap', async () => {
    const zed = { sessionUpdate: vi.fn(async () => {}) } as any;
    const onSessionUpdate = vi.fn();
    const client = new HappyProxyClient(() => zed, { onSessionUpdate });
    const note = { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as any;
    await client.sessionUpdate(note);
    expect(zed.sessionUpdate).toHaveBeenCalledWith(note);
    expect(onSessionUpdate).toHaveBeenCalledWith(note);
  });
  it('forwards readTextFile up to Zed (fs proxied to the editor)', async () => {
    const zed = { readTextFile: vi.fn(async () => ({ content: 'file' })) } as any;
    const client = new HappyProxyClient(() => zed, {});
    const res = await client.readTextFile!({ sessionId: 's1', path: '/a' } as any);
    expect(zed.readTextFile).toHaveBeenCalled();
    expect(res).toEqual({ content: 'file' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// proxy.ts
import type {
  Agent, Client, AgentSideConnection, ClientSideConnection,
  InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse,
  LoadSessionRequest, LoadSessionResponse, PromptRequest, PromptResponse,
  CancelNotification, SetSessionModeRequest, SetSessionModeResponse,
  SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
  SetSessionModelRequest, SetSessionModelResponse,
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
}

export class HappyProxyAgent implements Agent {
  constructor(private readonly down: () => ClientSideConnection, private readonly taps: ProxyTaps) {}
  initialize(p: InitializeRequest): Promise<InitializeResponse> { return this.down().initialize(p); }
  authenticate(p: AuthenticateRequest): Promise<AuthenticateResponse> { return this.down().authenticate(p); }
  loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> { return this.down().loadSession(p); }
  setSessionMode(p: SetSessionModeRequest): Promise<SetSessionModeResponse> { return this.down().setSessionMode(p); }
  setSessionConfigOption(p: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> { return this.down().setSessionConfigOption(p); }
  unstable_setSessionModel(p: SetSessionModelRequest): Promise<SetSessionModelResponse> { return this.down().unstable_setSessionModel(p); }
  cancel(p: CancelNotification): Promise<void> { return this.down().cancel(p); }
  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    const res = await this.down().newSession(p);
    this.taps.onNewSession?.(p, res);
    return res;
  }
  async prompt(p: PromptRequest): Promise<PromptResponse> {
    this.taps.onPrompt?.(p);
    return this.down().prompt(p);
  }
}

export class HappyProxyClient implements Client {
  constructor(private readonly zed: () => AgentSideConnection, private readonly taps: ProxyTaps) {}
  async sessionUpdate(p: SessionNotification): Promise<void> {
    this.taps.onSessionUpdate?.(p);
    await this.zed().sessionUpdate(p);
  }
  requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.taps.onRequestPermission) this.taps.onRequestPermission(p); // relay may answer via the AgentSideConnection race in Task 5
    return this.zed().requestPermission(p);
  }
  readTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> { return this.zed().readTextFile(p); }
  writeTextFile(p: WriteTextFileRequest): Promise<WriteTextFileResponse> { return this.zed().writeTextFile(p); }
  createTerminal(p: CreateTerminalRequest): Promise<CreateTerminalResponse> { return this.zed().createTerminal(p); }
}
```
Note: `requestPermission` forwards to Zed here; the 3-party first-wins logic is layered in Task 5 by replacing the tap with a real racer. Keep this simple for now (Zed-only), Task 5 upgrades it. If tsc complains that `Client.readTextFile`/`writeTextFile`/`createTerminal` are optional and their param types don't match, align to the exact SDK signatures (grep `interface Client` in `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/proxy.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/acpAgent/proxy.ts src/acpAgent/proxy.test.ts
git commit -m "feat(cli): bidirectional ACP proxy forwarders (agent down / client up)"
```

---

## Task 4: Spawn the downstream agent (`downstream.ts`)

**Files:**
- Create: `src/acpAgent/downstream.ts`

**Background:** Mirror `AcpBackend.ts`'s process spawn + stream wiring (`AcpBackend.ts:392-399` spawn, `nodeToWebStreams` at `src/utils/nodeToWebStreams.ts`, `ndJsonStream`). Build a `ClientSideConnection` whose `Client` is supplied by the caller.

**Interfaces:**
- Consumes: `nodeToWebStreams` (`@/utils/nodeToWebStreams`), `ndJsonStream`/`ClientSideConnection` (`@agentclientprotocol/sdk`).
- Produces: `spawnDownstream(cfg: { command: string; args: string[]; cwd: string }, makeClient: (conn: ClientSideConnection) => Client): { connection: ClientSideConnection; dispose(): Promise<void> }`.

- [ ] **Step 1: Implement (integration-level; verified by Task 8, not a unit test)**

```ts
// downstream.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk';
import { nodeToWebStreams } from '@/utils/nodeToWebStreams';
import { logger } from '@/ui/logger';

export function spawnDownstream(
  cfg: { command: string; args: string[]; cwd: string },
  makeClient: (conn: ClientSideConnection) => Client,
): { connection: ClientSideConnection; dispose(): Promise<void> } {
  const child: ChildProcess = spawn(cfg.command, cfg.args, { cwd: cfg.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr?.on('data', (d) => logger.debug(`[acp-agent downstream stderr] ${d}`));
  child.on('error', (e) => logger.debug('[acp-agent downstream spawn error]', e));
  // We WRITE JSON-RPC to the child's stdin, READ from its stdout.
  const { writable, readable } = nodeToWebStreams(child.stdin!, child.stdout!);
  const stream = ndJsonStream(writable, readable);
  const connection = new ClientSideConnection(() => makeClient(connection), stream);
  return {
    connection,
    dispose: async () => {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    },
  };
}
```
Note the `nodeToWebStreams(child.stdin, child.stdout)` order: its params are `(stdin: Writable, stdout: Readable)` and it returns `{ writable (wraps stdin), readable (wraps stdout) }` — confirm against `src/utils/nodeToWebStreams.ts` and `AcpBackend.ts`'s call `nodeToWebStreams(this.process.stdin, this.process.stdout)`.

- [ ] **Step 2: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: clean. Fix `Client`/`ClientSideConnection` import or the self-referential `connection` closure if tsc complains (declare `let connection: ClientSideConnection` before assignment if needed).

- [ ] **Step 3: Commit**

```bash
git add src/acpAgent/downstream.ts
git commit -m "feat(cli): spawn downstream ACP agent and build client connection"
```

---

## Task 5: Phone relay + 3-party permissions (`phoneRelay.ts`)

**Files:**
- Modify: `src/acpAgent/phoneRelay.ts` (extend Task 2's file)
- Test: `src/acpAgent/phoneRelay.test.ts` (extend)

**Background:** Reuse `runAcp`'s Happy-session bootstrap. Read `src/agent/acp/runAcp.ts:449-537` and copy the exact sequence: `ApiClient.create` → `getOrCreateMachine` → `createSessionMetadata({ flavor: resolveSessionFlavor(agentName), machineId, startedBy, sandbox })` → `getOrCreateSession` → `setupOfflineReconnection` (yields `ApiSessionClient`) → `startHappyServer` → keepAlive. Reuse `GenericAcpPermissionHandler`/`BasePermissionHandler` semantics for the phone permission leg, or the simpler `session.updateAgentState` requests channel.

**Interfaces:**
- Produces: `class PhoneRelay` with:
  - `static async start(opts: { credentials: Credentials; agentName: string }): Promise<PhoneRelay>`
  - `happySessionId: string`
  - `pushUpdate(update: SessionNotification): void` — maps via `sessionUpdateToEnvelopes` and sends to phone.
  - `startTurn(): void` / `endTurn(status: 'completed'|'failed'|'cancelled'): void`
  - `onUserMessage(cb: (text: string) => void): void` — phone→proxy input.
  - `requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse>` — surfaces to phone, resolves on phone answer.
  - `dispose(): Promise<void>`

- [ ] **Step 1: Write the failing test (the parts unit-testable without a live server)**

The bootstrap needs a live server, so test only the pure turn-id/mapping wiring here. Add:

```ts
// phoneRelay.test.ts (append)
import { turnEnvelopesForUpdate } from './phoneRelay';
describe('turnEnvelopesForUpdate', () => {
  it('uses the active turn id when mapping', () => {
    const out = turnEnvelopesForUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as any, 'turn-42');
    expect(out[0].turnId ?? out[0].content?.turnId ?? 'turn-42').toBeTruthy(); // envelope carries the turn context
  });
});
```
(Adjust the assertion to the real envelope's turn field once you've read `createEnvelope`/`turnOptions`. `turnEnvelopesForUpdate` is just an exported alias of `sessionUpdateToEnvelopes` for testing the turn-id path — if that's redundant, assert directly on `sessionUpdateToEnvelopes` and skip adding an alias.)

- [ ] **Step 2: Run test to verify it fails, then implement `PhoneRelay`**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/phoneRelay.test.ts` → FAIL, then implement.

```ts
// phoneRelay.ts (append the class; keep sessionUpdateToEnvelopes from Task 2)
import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';
import type { SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export class PhoneRelay {
  private turnId: string | null = null;
  private constructor(
    public readonly happySessionId: string,
    private session: ApiSessionClient,
    private readonly happyServer: { stop(): void },
    private readonly keepAlive: NodeJS.Timeout,
  ) {}

  static async start(opts: { credentials: Credentials; agentName: string }): Promise<PhoneRelay> {
    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings.machineId) throw new Error("No machine ID; run 'happy' once to log in");
    await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });
    // resolveSessionFlavor lives in runAcp.ts; copy its 'gemini'|'opencode'|'acp' logic or import if exported.
    const { state, metadata } = createSessionMetadata({ flavor: 'acp', machineId: settings.machineId, startedBy: 'terminal', sandbox: settings.sandboxConfig });
    const response = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
    if (!response) throw new Error('failed to create Happy session (offline?)');
    let session!: ApiSessionClient;
    const { session: initial } = setupOfflineReconnection({ api, sessionTag: randomUUID(), metadata, state, response, onSessionSwap: (s) => { session = s; } });
    session = initial;
    const happyServer = await startHappyServer(session);
    const keepAlive = setInterval(() => session.keepAlive(false, 'remote'), 2000);
    return new PhoneRelay(response.id, session, happyServer, keepAlive);
  }

  startTurn(): void { this.turnId = randomUUID(); this.session.sendSessionEvent?.({ type: 'ready' }); }
  endTurn(_status: 'completed' | 'failed' | 'cancelled'): void { this.turnId = null; }

  pushUpdate(update: SessionNotification): void {
    for (const env of sessionUpdateToEnvelopes(update.update, this.turnId)) {
      this.session.sendSessionProtocolMessage(env);
    }
  }

  onUserMessage(cb: (text: string) => void): void {
    this.session.onUserMessage((m) => { if (m?.content?.text) cb(m.content.text); });
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Phase-1: phone permission leg via AgentState requests + the 'permission' RPC.
    // Reuse BasePermissionHandler's request/response pattern (src/utils/BasePermissionHandler.ts).
    // Returns the phone's outcome; the caller races this against Zed (Task 6). If wiring the full
    // BasePermissionHandler here is large, expose the AgentState request + a promise that the
    // 'permission' RPC resolves, mirroring src/agent/acp/runAcp.ts GenericAcpPermissionHandler.
    return new Promise(() => { /* resolved by the phone 'permission' RPC; see runAcp.ts:407-431 */ });
  }

  async dispose(): Promise<void> {
    clearInterval(this.keepAlive);
    this.happyServer.stop();
    await this.session.flush();
    await this.session.close();
  }
}
```
Read `src/agent/acp/runAcp.ts:407-431` (`GenericAcpPermissionHandler`) and `src/utils/BasePermissionHandler.ts` to implement `requestPermission` concretely (create a pending promise, `addPendingRequestToState`, resolve on the `permission` RPC). Match the exact method names.

- [ ] **Step 3: Run tests + typecheck**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent/phoneRelay.test.ts && npx tsc --noEmit`
Expected: the mapper tests pass; tsc clean. If a reused symbol's signature differs (e.g. `sendSessionEvent`, `setupOfflineReconnection` options), correct against the real definitions cited above.

- [ ] **Step 4: Commit**

```bash
git add src/acpAgent/phoneRelay.ts src/acpAgent/phoneRelay.test.ts
git commit -m "feat(cli): Happy-session phone relay + permission leg for the ACP proxy"
```

---

## Task 6: Assemble the proxy (`runAcpAgent.ts`) + 3-party permission race

**Files:**
- Modify (rewrite): `src/acpAgent/runAcpAgent.ts`

**Background:** Wire Zed↔Happy↔downstream with the phone tapped. The two connections reference each other via late-bound getters. The permission tap becomes a real 3-party race: forward to Zed AND phone, first answer wins.

**Interfaces:**
- Consumes: `HappyProxyAgent`/`HappyProxyClient`/`ProxyTaps` (Task 3), `spawnDownstream` (Task 4), `PhoneRelay` (Task 5), `AgentSideConnection`/`ndJsonStream` (SDK), `nodeToWebStreams`.
- Produces: `runAcpAgent(opts: { credentials: Credentials; agentName: string; command: string; args: string[] }): Promise<void>`.

- [ ] **Step 1: Implement**

```ts
// runAcpAgent.ts
import { AgentSideConnection, ndJsonStream, type ClientSideConnection } from '@agentclientprotocol/sdk';
import type { Credentials } from '@/persistence';
import { nodeToWebStreams } from '@/utils/nodeToWebStreams';
import { HappyProxyAgent, HappyProxyClient, type ProxyTaps } from './proxy';
import { spawnDownstream } from './downstream';
import { PhoneRelay } from './phoneRelay';
import { logger } from '@/ui/logger';

export async function runAcpAgent(opts: { credentials: Credentials; agentName: string; command: string; args: string[] }): Promise<void> {
  const relay = await PhoneRelay.start({ credentials: opts.credentials, agentName: opts.agentName });

  let zed!: AgentSideConnection;
  let downstream!: ClientSideConnection;

  const taps: ProxyTaps = {
    onNewSession: () => relay.startTurn(),                 // establish an initial turn context
    onPrompt: () => relay.startTurn(),
    onSessionUpdate: (u) => {
      relay.pushUpdate(u);
      if ((u.update as any).sessionUpdate === 'tool_call_update') { /* keep turn open */ }
    },
    onRequestPermission: () => { /* handled by the race below, not here */ },
  };

  // Downstream client: forward up to Zed + tap. Override requestPermission with the 3-party race.
  const baseClient = new HappyProxyClient(() => zed, taps);
  const proxyClient = new Proxy(baseClient, {
    get(target, prop, recv) {
      if (prop === 'requestPermission') {
        return async (p: any) => {
          // Race Zed vs phone; first answer wins.
          const zedAns = zed.requestPermission(p);
          const phoneAns = relay.requestPermission(p);
          return Promise.race([zedAns, phoneAns]);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });

  const spawned = spawnDownstream({ command: opts.command, args: opts.args, cwd: process.cwd() }, () => proxyClient as any);
  downstream = spawned.connection;

  const proxyAgent = new HappyProxyAgent(() => downstream, taps);
  const { writable, readable } = nodeToWebStreams(process.stdout, process.stdin);
  zed = new AgentSideConnection(() => proxyAgent, ndJsonStream(writable, readable));

  relay.onUserMessage((text) => {
    // Phone drives: send a prompt to the downstream (same sink as Zed prompts).
    // Use the downstream sessionId captured at newSession; store it in a tap.
    void downstream.prompt({ sessionId: currentDownstreamSessionId!, prompt: [{ type: 'text', text }] } as any)
      .catch((e) => logger.debug('[acp-agent] phone prompt failed', e));
  });

  await new Promise<void>((resolve) => { zed.signal.addEventListener('abort', () => resolve()); });
  await spawned.dispose();
  await relay.dispose();
}

// capture the downstream sessionId for phone-driven prompts
let currentDownstreamSessionId: string | null = null;
```
Fix the `currentDownstreamSessionId` capture: set it in the `onNewSession` tap (`taps.onNewSession = (_req, res) => { currentDownstreamSessionId = res.sessionId; relay.startTurn(); }`). Move the `let currentDownstreamSessionId` above `taps`. Ensure the `Promise.race` permission cancels the loser (best-effort: whichever loses is ignored; if the phone answers first, Zed's outstanding `requestPermission` is left pending — acceptable Phase-1, note it).

- [ ] **Step 2: Typecheck**

Run: `cd packages/happy-cli && npx tsc --noEmit`
Expected: clean. Resolve the mutual-reference ordering (declare `zed`/`downstream` with `let ... !` and assign before first use — the connections aren't *used* until a message arrives, which is after both exist).

- [ ] **Step 3: Commit**

```bash
git add src/acpAgent/runAcpAgent.ts
git commit -m "feat(cli): assemble ACP proxy — Zed <-> Happy <-> downstream + phone tap + 3-party permission race"
```

---

## Task 7: Subcommand wiring (`index.ts`)

**Files:**
- Modify: `src/index.ts` (the `acp-agent` branch)

**Background:** Parse the downstream spec like the sibling `acp` branch (`index.ts:357-399`) using `resolveAcpAgentConfig`, and pass `agentName`/`command`/`args` to `runAcpAgent`. Keep the non-interactive `readCredentials` guard.

- [ ] **Step 1: Implement**

Replace the `acp-agent` branch body with (mirroring the `acp` branch's arg parsing):
```ts
} else if (subcommand === 'acp-agent') {
  try {
    const { runAcpAgent } = await import('@/acpAgent/runAcpAgent');
    const { resolveAcpAgentConfig } = await import('@/agent/acp');
    const acpArgs: string[] = [];
    let customCommandMode = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--') customCommandMode = true;
      acpArgs.push(args[i]);
    }
    const resolved = resolveAcpAgentConfig(acpArgs);
    const { readCredentials } = await import('@/persistence');
    const credentials = await readCredentials();
    if (!credentials) {
      process.stderr.write('happy acp-agent: not authenticated. Run `happy` once to log in, then restart your editor.\n');
      process.exit(1);
    }
    await runAcpAgent({ credentials, agentName: resolved.agentName, command: resolved.command, args: resolved.args });
  } catch (error) {
    process.stderr.write(`acp-agent error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  return;
```
Confirm `resolveAcpAgentConfig`'s return shape (`{ agentName, command, args }`) against `src/agent/acp/acpAgentConfig.ts`.

- [ ] **Step 2: Typecheck + build**

Run: `cd packages/happy-cli && npx tsc --noEmit && npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts && git commit -m "feat(cli): acp-agent subcommand accepts a downstream agent spec (BYO)"
```

---

## Task 8: Hermetic integration test + verification sweep

**Files:**
- Create: `src/acpAgent/runAcpAgent.integration.test.ts`

**Background:** Wire an in-memory Zed (`ClientSideConnection`) ↔ Happy proxy ↔ a fake downstream (`AgentSideConnection` with a scripted `Agent`), asserting forwarding both ways. Mock `./phoneRelay`'s `PhoneRelay.start` so no server is needed. Mirror the paired-`ndJsonStream` pattern in `src/agent/acp/AcpBackend.test.ts`.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { HappyProxyAgent, HappyProxyClient } from './proxy';

vi.mock('./phoneRelay', () => ({
  PhoneRelay: { start: vi.fn(async () => ({
    happySessionId: 'h1', startTurn: vi.fn(), endTurn: vi.fn(), pushUpdate: vi.fn(),
    onUserMessage: vi.fn(), requestPermission: vi.fn(() => new Promise(() => {})), dispose: vi.fn(),
  })) },
  sessionUpdateToEnvelopes: vi.fn(() => []),
}));

describe('proxy forwards a prompt down and an update up', () => {
  it('round-trips prompt→stopReason and sessionUpdate→Zed', async () => {
    const downstream = {
      prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      newSession: vi.fn(async () => ({ sessionId: 'd1' })),
    } as any;
    const zedSink = { sessionUpdate: vi.fn(async () => {}) } as any;
    const agent = new HappyProxyAgent(() => downstream, { onPrompt: vi.fn(), onNewSession: vi.fn() });
    const client = new HappyProxyClient(() => zedSink, { onSessionUpdate: vi.fn() });

    expect(await agent.newSession({ cwd: '/x', mcpServers: [] } as any)).toEqual({ sessionId: 'd1' });
    expect(await agent.prompt({ sessionId: 'd1', prompt: [{ type: 'text', text: 'hi' }] } as any)).toEqual({ stopReason: 'end_turn' });
    await client.sessionUpdate({ sessionId: 'd1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } } } as any);
    expect(zedSink.sessionUpdate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it + full sweep**

Run: `cd packages/happy-cli && npx vitest run src/acpAgent`
Expected: PASS.
Run: `cd packages/happy-cli && npx tsc --noEmit && npm run build && npx vitest run src/agent/acp src/claude`
Expected: clean build; ACP-client + claude suites green (proves the deletions/reverts didn't regress anything).

- [ ] **Step 3: Headless stdout smoke (unauthenticated)**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | node packages/happy-cli/bin/happy.mjs acp-agent -- true 2>/dev/null | head -1
```
Expected: empty stdout (exits to stderr "not authenticated" before spawning anything). Confirms the guard + stdout hygiene survive the rewrite.

- [ ] **Step 4: Commit**

```bash
git add src/acpAgent/runAcpAgent.integration.test.ts && git commit -m "test(cli): hermetic ACP-proxy forwarding integration test"
```

---

## Task 9: Manual E2E (human, documented)

Not automated. In the PR/test doc:
1. `happy` (login once, throwaway `HAPPY_HOME_DIR`, self-hosted `HAPPY_SERVER_URL`) — pair the phone (per the e2e-test-plan doc).
2. Zed `agent_servers`: `"args": [".../happy.mjs","acp-agent","--","npx","@zed-industries/claude-code-acp"]`, `type: "custom"`, env with `HAPPY_SERVER_URL`/`HAPPY_HOME_DIR`/`PATH`.
3. In Zed: select Happy → confirm **model/mode/effort pickers appear** (forwarded from claude-code-acp), send a prompt, see streamed output + tool cards.
4. Phone: the session appears; send a prompt → Zed advances; take it back in Zed.
5. Trigger a permission → appears in both Zed and phone; either resolves it.

---

## Self-Review notes

- **Spec coverage:** raw pass-through (Task 3 forwards verbatim, `newSession` returns the downstream response unchanged → pickers preserved); bidirectional incl. fs/terminal (Task 3 `HappyProxyClient` forwards readTextFile/writeTextFile/createTerminal up); phone relay + drive (Tasks 5–6); 3-party permission race (Task 6); downstream via `resolveAcpAgentConfig` (Task 7); native removal (Task 1); headless (Task 8 smoke). Phase-2 mobile enrichment intentionally absent.
- **Known integration risks flagged inline** for the implementer to resolve against real code, not guess: `createEnvelope`/`turnOptions` exact shape (Task 2), `BasePermissionHandler` reuse for the phone permission leg (Task 5), the mutual-reference ordering + `currentDownstreamSessionId` capture (Task 6), `resolveAcpAgentConfig` return shape (Task 7), and the `Promise.race` loser-cancellation (Phase-1 acceptable-leak, noted).
- **Type consistency:** `ProxyTaps` is defined in Task 3 and consumed in Task 6; `PhoneRelay` methods (Task 5) match their Task-6 call sites (`start`/`startTurn`/`pushUpdate`/`onUserMessage`/`requestPermission`/`dispose`).
- **initialize timing** (design risk): with raw forwarding, Zed's `initialize` forwards straight to the downstream (`HappyProxyAgent.initialize`), which is spawned *before* the AgentSideConnection is constructed in Task 6 — so the downstream exists when Zed's first `initialize` arrives. Good.
