# Happy as an ACP Agent — Single Session, Two Faces

**Status:** Design proposal (pre-implementation)
**Date:** 2026-07-03
**Scope:** Add an ACP *agent/server* surface to the Happy CLI so an ACP-capable editor (Zed's agent panel) can drive the same Happy-owned Claude Code session that the phone drives.

---

## 1. Summary

Happy already owns a live, wrapped, sync'd Claude Code session (`happy claude`) and fans it out to mobile/web clients through its server relay. This project adds a second northbound face — **ACP (Agent Client Protocol)** — so that when an editor like Zed spawns `happy` as its ACP agent, the resulting editor thread *is* a normal Happy session and is therefore remote-controllable from the phone with no extra work.

One `happy` process, launched by Zed, faces two directions at once:

- **Down, to Zed, over stdio:** speaks ACP as the *agent/server*. Zed sends prompts; Happy streams assistant text, thinking, tool calls, diffs, and permission requests back as ACP notifications.
- **Up, to the phone, over the network:** an ordinary Happy CLI session. Registers with Happy's server, relays the encrypted stream, and the phone joins exactly as it joins a `happy claude` session today.

In the middle sits the real Claude Code, driven the way Happy already drives it in remote mode (the Agent SDK path). Claude's output is **mirrored to both faces**, so the editor panel and the phone always render the same live thread regardless of which one drove the last turn.

## 2. Problem

Editors run Claude Code through an ACP adapter (`claude-code-acp`) that drives Claude via the Agent SDK. Anthropic's Remote Control can attach a phone to a *CLI* session but not to an editor's SDK session, and there's no programmatic way to enable it on the editor's session (anthropics/claude-code#29006). Resuming the same Claude session id in a second process fails on the single-writer constraint: a Claude session file has effectively one live owner, so a second process forces a "stop / hand off / resume" dance.

Happy avoids that by being the single owner from the start and multiplexing clients. The only thing it can't do today is be that owner *for an editor panel*, because it has no ACP agent surface. This project adds exactly that.

## 3. Relationship to prior work (#267)

Issue #267 added ACP to Happy — but as an ACP **client**: Happy *spawns* Gemini/opencode and drives them (`AcpBackend implements AgentBackend`, `packages/happy-cli/src/agent/acp/AcpBackend.ts:317`). This project is the **inverse**: Happy as the ACP **agent/server** that an editor spawns.

Verified reuse facts:

- **Correct ACP, confirmed.** The dependency is `@agentclientprotocol/sdk` (Zed Industries' Agent *Client* Protocol — editor↔agent, JSON-RPC over stdio), `packages/happy-cli/package.json:74`. **Not** the IBM/BeeAI "Agent Communication Protocol" that merged into A2A. The reuse story is real.
- **Both wire halves ship in the same SDK.** Happy uses `ClientSideConnection` today (`AcpBackend.ts:709`). The server counterpart is **`AgentSideConnection`** (`node_modules/@agentclientprotocol/sdk/dist/acp.d.ts:17`), constructed as `new AgentSideConnection(conn => agentImpl, stream)`. Same `ndJsonStream`, same `ContentBlock`/`SessionNotification`/`RequestPermissionRequest` types the existing code already imports.
- **The method surface we must implement is the exact mirror of what `AcpBackend` already handles.** The `Agent` interface (Zed → Happy) is: `initialize`, `newSession`, `loadSession?`, `setSessionMode?`, `setSessionConfigOption?`, `authenticate`, `prompt`, `cancel` (`acp.d.ts`). The calls we make toward Zed via `AgentSideConnection` are: `sessionUpdate`, `requestPermission`, `readTextFile`/`writeTextFile`, `createTerminal`.

## 4. Codebase-grounded findings

These correct or confirm the hypotheses in the original handover. **The code wins where it disagrees.**

1. **Fan-out and history are server-side, not CLI-side.** The CLI's `ApiSessionClient` (`packages/happy-cli/src/api/apiSession.ts:188`) is one Socket.IO client (`:258`) of Happy's server; the server (`packages/happy-server/sources/app/events/eventRouter.ts`) relays to a room and *is* the persistence + fan-out hub. There is **no CLI-held thread snapshot** — a client rebuilds state by paging `GET /v3/sessions/:id/messages` (`apiSession.ts:581`). *Consequence:* the phone side of our feature needs zero new fan-out code; registering the session is enough.

2. **The "floor" today is binary `mode: 'local' | 'remote'`, not per-client.** It's a CLI-local state machine (`packages/happy-cli/src/claude/loop.ts:76`, mirrored on `Session.mode`, `session.ts:27`): local = terminal owns Claude, remote = mobile drives via `session.queue`. There is **no per-client identity** (messages carry only a free-form `meta.sentFrom` string, `packages/happy-wire/src/messageMeta.ts:4`) and **no server-side arbiter**. "Remote" is a *collective* of anonymous clients. *Consequence:* the handover's clean 3-way `requestControl` maps onto nothing that exists; see §7 for the model we actually adopt.

3. **"Press any key to take over"** = `interpretRemoteModeKeypress` (double-space / Ctrl-T → switch to local), `packages/happy-cli/src/ui/ink/RemoteModeDisplay.tsx:20`. It's a keypress-to-mode-switch, not a general control primitive.

4. **Permissions are already session-scoped** — better than the handover assumed. Claude's tool-approval is captured via the SDK `canUseTool` callback → `PermissionHandler.handleToolCall` (`packages/happy-cli/src/claude/utils/permissionHandler.ts:132`). A pending request is keyed by tool-use id in `pendingRequests` (`:34`) and mirrored into `AgentState.requests` (`packages/happy-cli/src/api/types.ts:363`), which is broadcast encrypted to all clients. Any client answers via the `permission` RPC (`:344`); first response wins. *Consequence:* "permission belongs to the session" is largely free — we bridge, not re-architect.

5. **The hard stdio constraint.** If Zed spawns `happy`, `happy`'s own stdin/stdout *is* the JSON-RPC pipe. Today the CLI renders Ink to stdout (`claudeRemoteLauncher.ts:41`), puts stdin in raw mode (`:64`), and inherits fd0/1/2 into a child `claude` in local mode (`claudeLocal.ts:316`). All three corrupt a JSON-RPC stream. *Consequence:* ACP-agent mode **must be headless** (§8).

6. **Claude is always a child OS process, driven two ways.** Local mode spawns `claude` with inherited stdio (`claudeLocal.ts`); remote mode uses `@anthropic-ai/claude-agent-sdk` (`claudeRemote.ts:16`, `query()` at `:164`), which spawns its own `claude` subprocess and streams stream-json. Remote mode is the reusable engine — it needs no terminal.

7. **`AgentBackend` is not universal.** The `AgentBackend` interface (`packages/happy-cli/src/agent/core/AgentBackend.ts:104`) and `AgentMessage` union are implemented only by the ACP-client / Gemini / OpenClaw paths. The production Claude path uses `Session` + `ApiSessionClient` + `loop` directly. So our surface plugs into the *Claude* machinery, borrowing ACP *types* from the `agent/acp` code but not routing through `AgentBackend`.

## 5. Architecture

```
                    ┌───────────────────────────── happy (headless ACP-agent mode) ─────────────────────────────┐
                    │                                                                                            │
   Zed panel        │   ACP server face                    core engine                    Happy relay face      │      Happy server        Phone
   ─────────        │   ───────────────                    ───────────                     ────────────────      │      ────────────        ─────
      │  prompt ───────► AgentSideConnection ──┐                                                                 │
      │             │   (Agent impl)           ├──► session.queue ──► claudeRemote (SDK) ──► child `claude`      │
      │             │                          │        ▲                     │                                  │
      │             │                          │        │                     │ SDK stream / AgentMessages       │
      │             │                          │        │                     ▼                                  │
      │  ◄─ session/update ── ACP translator ◄─┼────────┼──────────── mirror ──┤                                 │
      │  ◄─ requestPermission ◄────────────────┼─ perm bridge ◄── canUseTool ──┤                                 │
      │             │                          │        │                     │                                  │
      │             │                          │        │                     └─► sendClaudeSessionMessage ──────┼──► relay room ──────────► phone
      │             │                          │        └──────────────────────── onUserMessage ◄───────────────┼──◄ relay ◄─── phone prompt
      │             │                                                                                            │
                    └────────────────────────────────────────────────────────────────────────────────────────┘
```

**Components (each with one job):**

- **ACP server face** — an implementation of the SDK's `Agent` interface wired to `AgentSideConnection` over `ndJsonStream(process.stdout, process.stdin)`. Translates Zed's `initialize`/`newSession`/`prompt`/`cancel`/`setSessionMode` into core-engine operations. New code, but a thin mirror of `AcpBackend`.
- **Core engine** — the existing remote-mode Claude driver (`session.queue`, `claudeRemote`, `ApiSessionClient`), unchanged, run in a headless configuration.
- **ACP translator** — subscribes to the engine's outbound message stream and emits ACP `session/update` notifications to Zed. Reuses the message→content-block mapping logic that `AcpSessionManager`/`sessionUpdateHandlers` already implement, run in reverse.
- **Permission bridge** — when the engine raises a permission request, also call `AgentSideConnection.requestPermission` toward Zed; resolve whichever side answers first and cancel the other.
- **Happy relay face** — the existing `ApiSessionClient`, unchanged. Registers the session, relays the stream, receives phone prompts via `onUserMessage`.

## 6. Integration map (ACP method → Happy call/event)

The deliverable that proves this is a bounded adapter. Each row is either a concrete Happy call or an explicit gap.

### Inbound — `Agent` methods Zed calls on Happy

| ACP method | Happy mapping | Notes |
|---|---|---|
| `initialize` | Static capability response | Advertise `promptCapabilities`, `loadSession` (see gap), permission + mode support. Mirror `AcpBackend.ts:715` initialize logic, inverted. |
| `authenticate` | No-op / success | Happy auth is its own account secret (`auth.ts`), independent of ACP. Return success; real auth happens when the session registers with Happy's server. |
| `newSession(cwd, mcpServers)` | Start a headless Happy session: `ApiClient.getOrCreateSession` (`api.ts:30`) → build `ApiSessionClient` → start the remote Claude loop with `cwd`. Return the ACP `sessionId`. | ACP `sessionId` ↔ Happy session id mapping held in the ACP face. `mcpServers` from Zed merge with Happy's own MCP config. |
| `prompt(sessionId, prompt[])` | Map ACP `ContentBlock[]` → text/attachments → `messageQueue.push(...)` (the same sink `onUserMessage` uses, `runClaude.ts:815`). Await turn completion, return `stopReason`. | This is the editor driving a turn. |
| `cancel(sessionId)` | Abort the current turn (the existing `abort` path, `claudeRemoteLauncher.ts`). | Maps to ACP `cancelled` stop reason. |
| `setSessionMode` | Set permission mode via the per-turn mechanism (`meta.permissionMode`, resolved in `runClaude.ts:652`) or the live `Query.setPermissionMode` hook (`claudeRemote.ts:170`). | ACP modes ↔ Happy `PermissionMode` (`types.ts:35`); reuse `mapToClaudeMode` (`permissionMode.ts:19`). |
| `setSessionConfigOption` | Map to model/effort/tool overrides (same override resolution as per-message metadata). | Reuse `sessionConfigMetadata.ts` mappings from the client side. |
| `loadSession` (optional) | **Gap (v1):** thread restore. Happy history lives server-side (`GET /v3/sessions/:id/messages`); reconstructing an ACP thread from it is possible but non-trivial. Advertise `loadSession: false` in v1; defer. | See §9 follow-ups. |

### Outbound — calls Happy makes toward Zed via `AgentSideConnection`

| Happy event (engine) | ACP call | Notes |
|---|---|---|
| Assistant text delta | `sessionUpdate({ agent_message_chunk })` | From the SDK stream / mapped `AgentMessage`. |
| Thinking delta | `sessionUpdate({ agent_thought_chunk })` | |
| Tool call start | `sessionUpdate({ tool_call })` | Map Claude tool_use → ACP tool call; reuse `sessionUpdateHandlers.ts` shapes. |
| Tool call progress/result | `sessionUpdate({ tool_call_update })` | Include diffs/file changes as ACP tool-call content so the panel renders edits. |
| Plan / available commands | `sessionUpdate({ plan / available_commands_update })` | Optional; map if present. |
| Mode change | `sessionUpdate({ current_mode_update })` | Keep Zed's mode indicator in sync when the phone changes mode. |
| Permission request (`canUseTool`) | `requestPermission(...)` | Permission bridge (§7.2). |
| **Phone-driven turn output** | Same `sessionUpdate(...)` stream, pushed **unsolicited** | The key to remote control: ACP allows `session/update` outside a `prompt` response, so Happy narrates phone-driven turns into Zed's panel. |

### File access

Claude does its own file IO on the local machine (same host as `happy`), so v1 does **not** route reads/writes through Zed's `fs/read_text_file` / `fs/write_text_file`. We surface edits to Zed as tool-call content for display only. (Revisit if we ever want Zed's unsaved-buffer state to win over disk — a follow-up.)

## 7. Control model (the decision)

**Adopted for v1: soft floor / mirror-everything.** No new arbitration protocol.

### 7.1 How control works

- Both Zed and the phone are drivers. Zed's prompts enter `session.queue` via the ACP `prompt` method; the phone's prompts enter the *same* queue via the existing `onUserMessage` relay path.
- Every turn's Claude output is mirrored to both faces (§6 outbound table). So each side always renders the live thread regardless of who prompted — including Zed rendering phone-driven turns as unsolicited `session/update`s.
- **Rest-only takeover falls out for free** from the existing turn serialization (`MessageQueue2` processes one turn at a time): a new turn can only begin when idle, so takeover happens *between* turns, never mid-stream. No lock needed.
- "Who has the floor" is a **soft UI hint** (whose composer is lit), derived from who prompted last — not an enforced lock.

**Acceptance scenario is fully satisfied:** drive from Zed → pick up phone and drive a turn (Zed's panel advances via unsolicited updates) → sit back down and type in Zed again (it already shows the full thread; no restart). Rest-only holds because turns serialize.

**Known limitation (explicitly accepted for v1):** two clients *could* both enqueue a prompt during the same idle gap. The queue serializes them safely (both run, in order) — it's cooperative multi-driver, not a hard single-writer lock. Making the floor *enforced* (a `requestControl` token + "you're observing" events + composer disabling) is deferred (§9). This is the smaller, more reviewable v1 and leans entirely on existing machinery.

### 7.2 Permission bridge (session-owns-permissions)

When Claude raises a permission request, it is already in `AgentState.requests` and broadcast to all Happy clients (phone included). The bridge additionally calls `AgentSideConnection.requestPermission` toward Zed so the panel shows its native permission UI. Resolution:

- Whichever side answers first wins. If the phone answers via the `permission` RPC, resolve the SDK promise **and** cancel the outstanding ACP `requestPermission` toward Zed (ACP `RequestPermissionOutcome::Cancelled`). If Zed answers, feed the decision into the existing `handlePermissionResponse` (`permissionHandler.ts`) so the phone's banner clears via the normal `completedRequests` state update.
- Because the pending request is keyed to the session (not a client), the prompt already "follows the floor": it's visible wherever you look. The only new work is the ACP leg + first-wins cancellation.

## 8. Headless mode (the hard constraint)

ACP-agent mode is a distinct run mode with:

- **No Ink render.** Nothing writes to stdout except ACP JSON-RPC frames.
- **No raw-mode stdin / `useInput`.** stdin is the JSON-RPC byte stream only.
- **All human logging to stderr or the file logger** (`packages/happy-cli/src/ui/logger.ts` already logs to file; the CLAUDE.md convention is "all debugging through file logs").
- **Never inherit fd0/1/2 into child processes.** Claude runs only via the SDK path (`claudeRemote`), which manages its own child stdio; the terminal-inheriting `claudeLocal` path is unreachable in this mode.
- **No `console.log`.** The existing ACP-client code logs to stdout in places (`runAcp.ts`, `AcpBackend.ts`); the server face must route all of that away from stdout.

## 9. Out of scope for v1 (follow-ups)

- **Hard single-active-driver** — enforced floor token, `requestControl` RPC, explicit "you are now observing" events, displaced-composer disabling. v1 ships the soft floor; this is the enforcement upgrade.
- **Mid-turn takeover** — inheriting an in-flight response or half-answered permission prompt across a control transfer. v1 is rest-only.
- **`loadSession` / thread restore** — reconstructing an ACP thread from Happy's server-side message log so Zed can reopen a prior session.
- **Zed buffer-aware file IO** — routing file reads/writes through Zed's `fs` capability so unsaved editor state participates.
- **Non-Claude backends** — Codex/Gemini through the same ACP-agent face. v1 targets the Claude engine.

## 10. Testing / acceptance

- **Unit:** ACP `Agent` method handlers (map `prompt` content blocks → queue push; `cancel` → abort; `setSessionMode` → permission mode). Translator: engine message → `session/update` shape. Permission bridge: first-wins resolution + opposite-side cancellation. Mirror the existing `AcpSessionManager.test.ts` / `runAcp.test.ts` style.
- **Integration (headless):** spawn `happy` in ACP-agent mode with a scripted ndJSON client on stdio; assert `initialize`/`newSession`/`prompt` round-trips and streamed `session/update`s; assert nothing non-JSON hits stdout.
- **End-to-end (human):** point Zed's `agent_servers` at `happy` (ACP-agent mode) as a custom command, open a project, drive Claude from the panel, take control on the phone for a turn, then take it back in Zed — panel re-renders the full thread the phone advanced and accepts input, no restart, no lost context. A pending permission prompt appears on whichever client is active.

## 11. Risks / open questions

- **`AgentSideConnection` exact call ergonomics** — verified the class and method names against the installed SDK (`@agentclientprotocol/sdk@^0.14.1`); confirm streaming/notification semantics against `claude-code-acp` as the exemplar during implementation.
- **Two MCP configs** — Zed passes `mcpServers` in `newSession`; Happy has its own MCP setup (`bin/happy-mcp.mjs`). Define the merge precedence.
- **cwd / project identity** — Zed's `newSession.cwd` must map to Happy's project path (`projectPath.ts`) so the phone shows the right project.
- **Reconnect semantics** — if the ACP stdio connection drops (Zed restarts) but the Happy session is still live on the server, decide whether a fresh `happy` spawn re-attaches or starts clean. Likely a follow-up; note it.

## 12. Licensing

Happy is MIT; `claude-code-acp` (Zed Industries) is Apache-2.0. It's fine to study `claude-code-acp` as the protocol exemplar for method semantics; do not copy code without honoring its license/attribution. The ACP SDK (`@agentclientprotocol/sdk`) is a normal dependency, already in use.

## 13. Delivery plan

1. **This spec + the draft `slopus/happy` proposal issue** (`2026-07-03-happy-acp-agent-proposal-issue.md`) — get maintainer buy-in on the topology, the headless boundary, and the soft-floor control model **before** any adapter code.
2. **Only after buy-in:** the adapter — headless-mode plumbing, the ACP server face + translator, and the permission bridge, as a reviewable increment with concurrency deferred.
