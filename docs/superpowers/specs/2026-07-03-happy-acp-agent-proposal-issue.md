# Proposal: Happy as an ACP agent — one session, two faces (editor panel + phone)

> Draft GitHub issue for `slopus/happy`. Do not open without human review. Companion design doc: `2026-07-03-happy-acp-agent-surface-design.md`.

## The ask

Add an ACP **agent/server** surface to the CLI so an ACP-capable editor (Zed's agent panel) can spawn `happy` as its agent and get a thread that is automatically remote-controllable from the Happy mobile app — because that editor thread *is* a normal Happy session under the hood.

## Why this is cheap (it's the inverse of #267, not a rewrite)

#267 made Happy an ACP **client** (Happy spawns Gemini/opencode and drives them: `AcpBackend implements AgentBackend`, `src/agent/acp/AcpBackend.ts:317`). This is the mirror image — Happy as the ACP **agent** an editor spawns.

- Same, correct ACP: `@agentclientprotocol/sdk` (Zed's Agent *Client* Protocol), `package.json:74` — **not** the IBM/A2A one.
- Both wire halves are in the SDK we already depend on: we use `ClientSideConnection` today; the server counterpart is `AgentSideConnection` (`dist/acp.d.ts:17`), same `ndJsonStream` and `ContentBlock`/`SessionNotification`/`RequestPermissionRequest` types.
- The `Agent` interface we'd implement (`initialize`, `newSession`, `prompt`, `cancel`, `setSessionMode`, …) is the exact mirror of what `AcpBackend` already handles.

## Concept: one process, two faces

Zed spawns one `happy` process. It faces two ways at once:

- **Down to Zed (stdio):** speaks ACP as the server — streams assistant text, tool calls, diffs, permission requests.
- **Up to the phone (network):** a normal Happy session — registers with the server, and the phone joins like any `happy claude` session.

Real Claude Code runs in the middle via the existing SDK remote-mode engine. Its output is **mirrored to both faces**, so the panel and the phone always render the same live thread. Crucially, ACP allows an agent to push `session/update` notifications *outside* a `prompt` response — so when you drive a turn from your phone, Happy narrates it into Zed's panel and the panel just keeps advancing. Take control back by typing in Zed. No restart, no resume dance.

## What we found in the code (and what it changes)

- **Fan-out/history are server-side.** The CLI is one client of the server relay; the phone side needs *no new fan-out code* — registering the session is enough. (`src/api/apiSession.ts`, `packages/happy-server/.../eventRouter.ts`)
- **Permissions are already session-scoped** and broadcast to all clients (`AgentState.requests`, `src/claude/utils/permissionHandler.ts:132`). We add an ACP `requestPermission` leg with first-answer-wins; the prompt already "follows the floor."
- **Hard constraint — stdio.** Today the CLI renders Ink to stdout, raw-modes stdin, and inherits fd0/1/2 into child `claude`. All three corrupt JSON-RPC. So this must be a **headless run mode**: no Ink, no raw stdin, logs to stderr/file, Claude driven only via the SDK path (never the terminal-inheriting `claudeLocal`).

## Control model (v1): soft floor, not a hard lock

The current "floor" is the binary `local`/`remote` mode (`src/claude/loop.ts:76`) — there's no per-client identity and no server-side arbiter, so a literal 3-way `requestControl` maps onto nothing that exists. v1 instead: both faces feed one turn-queue; the queue serializes turns, so **rest-only takeover is free** (you can only start a turn when idle). "Who has the floor" is a soft UI hint.

**Explicitly deferred:** hard single-active-driver (enforced `requestControl` + "you're observing" events), mid-turn takeover, `loadSession` thread restore, and non-Claude backends. v1 is the small, reviewable increment.

## Process topology to confirm first

A new headless subcommand (e.g. `happy acp-agent`) that Zed's `agent_servers` points at. It owns stdin/stdout for JSON-RPC and runs the existing remote-Claude engine + `ApiSessionClient` with no terminal UI. Please sanity-check this topology before we write the adapter.

## Acceptance test

Point Zed at `happy` (ACP-agent mode) as a custom `agent_servers` command → drive Claude from the panel → take control on the phone for a turn → take it back in Zed. The panel re-renders the full thread the phone advanced and accepts input, no restart. A pending permission prompt shows on whichever client is active.

## Scope of the first PR

Headless-mode plumbing + ACP server face + output translator + permission bridge, over the existing Claude engine. Concurrency and thread-restore deferred. Design doc has the full method-by-method integration map.

*(Happy is MIT; `claude-code-acp` is Apache-2.0 — studied as a protocol exemplar, not copied.)*
