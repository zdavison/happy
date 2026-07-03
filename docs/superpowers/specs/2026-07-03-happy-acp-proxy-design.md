# Happy ACP Agent, v2 — BYO transparent ACP proxy

**Status:** Design proposal (supersedes the native-Claude `acp-agent` on branch `feat/happy-acp-agent`)
**Date:** 2026-07-03
**Decision trail:** We validated a native-Claude `acp-agent` end-to-end (Zed drives Claude via the SDK, phone mirrors + drives, permissions, cancel). We then chose **BYO-agent-only**: instead of Happy driving Claude itself, Happy proxies whatever ACP agent the user already runs (`claude-code-acp`, gemini, opencode, codex-acp, …). Rationale: universal by construction, model/mode/effort pickers forwarded for free, no per-agent model hardcoding, no agent-zoo to bundle. Mobile tool-card richness degrades to the "ACP tier" — accepted for Phase 1, recovered later in Phase 2 (it is an implementation gap, not a protocol limit; ACP carries diffs/kind/locations/raw I/O).

## 1. Summary

`happy acp-agent -- <downstream agent cmd>` becomes a **bidirectional ACP proxy**. Zed spawns Happy over stdio; Happy spawns the downstream agent over stdio; Happy forwards JSON-RPC **both ways** and taps the middle to relay to / accept input from the phone.

```
   Zed ──ACP(stdio)──▶ Happy ──ACP(stdio)──▶ downstream agent (claude-code-acp / gemini / …)
  (client)   AgentSideConnection │ ClientSideConnection      (agent)
                                 │
                                 └── tap ──▶ Happy relay ──▶ phone (render + drive + approve)
```

Happy is a **client** to the downstream (its `Agent`) and an **agent** to Zed (its `Client`). A transparent proxy forwards:
- **agent methods down:** Zed→Happy→downstream — `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `setSessionConfigOption`, `unstable_setSessionModel`.
- **client methods up:** downstream→Happy→Zed — `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`, `createTerminal` (+ terminal lifecycle).

Because everything the downstream advertises (`modes`/`models`/`configOptions`, `promptCapabilities`, `loadSession`) flows straight through, **Zed's pickers and capabilities match the downstream exactly, with zero per-agent code.**

## 2. Why a raw proxy (not `AgentBackend`)

Happy's existing ACP-client (`AcpBackend`) wraps `ClientSideConnection` but **normalizes** downstream ACP into the `AgentMessage` union (for the `runAcp` phone path). Routing Zed's traffic through that would double-translate (ACP→AgentMessage→ACP) and drop fields Zed wants (exact `configOptions`, `rawInput`, diff blocks). For **Zed fidelity — the whole point of BYO — we forward raw ACP verbatim.** We reuse `AgentSideConnection`/`ClientSideConnection`/`ndJsonStream` (already in the repo) and the `runAcp` **session/relay bootstrap**, but not `AcpBackend`'s AgentMessage layer on the Zed path.

## 3. Components

### 3.1 Downstream selection
Reuse #267's `resolveAcpAgentConfig` (`src/agent/acp/acpAgentConfig.ts`): `happy acp-agent -- <cmd> [args]`, or a known alias (`happy acp-agent gemini`). Zed config example:
```jsonc
"agent_servers": { "Happy": { "type": "custom", "command": "node",
  "args": [".../happy.mjs","acp-agent","--","npx","@zed-industries/claude-code-acp"],
  "env": { "HAPPY_SERVER_URL": "...", "HAPPY_HOME_DIR": "...", "PATH": "..." } } }
```

### 3.2 Northbound (to Zed) — `AgentSideConnection`
Reuse `runAcpAgent.ts` scaffolding: `nodeToWebStreams(process.stdout, process.stdin)` → `ndJsonStream` → `AgentSideConnection(conn => proxyAgent, stream)`. `proxyAgent` implements the `Agent` interface as **forwarders** to the downstream `ClientSideConnection`.

### 3.3 Southbound (to downstream) — `ClientSideConnection`
Happy spawns the downstream (`spawn(cmd, args, {stdio:['pipe','pipe','pipe']})`, mirror `AcpBackend.ts:399`), wraps its stdio with `nodeToWebStreams` + `ndJsonStream`, and constructs `new ClientSideConnection(agent => happyClient, stream)`. `happyClient` implements the `Client` interface as **forwarders up to Zed** (via the `AgentSideConnection`), with taps.

### 3.4 Method forwarding (the proxy core)

| Direction | Method | Behavior |
|---|---|---|
| Zed→down | `initialize` | Forward Zed's `clientCapabilities` down; return downstream's `InitializeResponse` (its `agentCapabilities`, `authMethods`) up to Zed verbatim. |
| Zed→down | `authenticate` | Forward. |
| Zed→down | `newSession(cwd, mcpServers)` | Also spin up the Happy relay session here (§3.5). Forward to downstream; return its `NewSessionResponse` (**incl. `modes`/`models`/`configOptions`**) to Zed verbatim. Keep a downstream-sessionId ↔ Happy-sessionId map. |
| Zed→down | `prompt` | Tap the prompt blocks → phone echo (user message). Forward to downstream; return its `stopReason`. |
| Zed→down | `cancel`, `setSessionMode`, `setSessionConfigOption`, `unstable_setSessionModel`, `loadSession` | Forward verbatim; return the downstream response. |
| down→Zed | `sessionUpdate` | Forward to Zed verbatim **and** tap → phone relay envelopes (§3.6). |
| down→Zed | `requestPermission` | 3-party (§3.7). |
| down→Zed | `readTextFile` / `writeTextFile` / `createTerminal` (+ terminal ops) | Forward up to Zed (the real editor owns the fs/terminal). |

### 3.5 Happy relay session (phone side) — reuse `runAcp`
At `newSession`, stand up the relay exactly as `runAcp` does (`runAcp.ts:458-519`): `ApiClient.create` → `getOrCreateMachine` → `createSessionMetadata({flavor: resolveSessionFlavor(agentName)})` → `getOrCreateSession` → `setupOfflineReconnection` (yields `ApiSessionClient`) → `startHappyServer` (MCP) → keepAlive interval. This is what makes the session appear on the phone.

### 3.6 Phone tap (relay + drive)
- **Downstream→phone:** translate each downstream `SessionNotification.update` into Happy `SessionEnvelope`s and `session.sendSessionProtocolMessage(...)`. Reuse `AcpSessionManager`'s envelope shapes; feed it from raw ACP `SessionUpdate` (either directly, or via the existing `sessionUpdateHandlers` ACP→AgentMessage step then `AcpSessionManager.mapMessage`). Emit `startTurn`/`endTurn` around prompts.
- **Phone→downstream:** `session.onUserMessage(msg => backendPrompt(msg.content.text, meta))` → forward as an ACP `prompt` to the downstream (same sink Zed prompts use). This is what lets the **phone drive**. Serialize with Zed prompts (one turn in flight; reuse the queue pattern from `runAcp`).

### 3.7 Permissions — 3-party, first-answer-wins
When the downstream calls `requestPermission`:
1. Forward it to **Zed** (`connection.requestPermission`) — native editor UI.
2. Surface it to the **phone** via the existing `AgentState.requests` channel (reuse `GenericAcpPermissionHandler`/`BasePermissionHandler` + the `permission` RPC).
3. **First** responder (Zed or phone) wins; respond to the downstream with that outcome; cancel/ignore the other leg (Zed's outstanding request resolves as cancelled or is ignored; phone's `AgentState` entry moves to completed). Generalizes the first-answer-wins bridge we built.

### 3.8 fs / terminal
The downstream expects its client (Happy) to provide `fs`/`terminal`. Happy forwards those calls up to Zed, which has the real workspace fs/terminal. Advertise to the downstream (in Happy→downstream `initialize`) the `clientCapabilities` Zed advertised to Happy, so the downstream only calls what Zed supports.

## 4. What is removed / reverted from the current branch

The native-Claude drive is superseded. Remove:
- `src/acpAgent/engine.ts` (Claude-SDK bootstrap)
- `src/acpAgent/sdkMessageToAcp.ts`, `src/acpAgent/contentBlocks.ts` (SDK↔ACP translation — unneeded; downstream is already ACP)
- Revert the native-engine taps: `session.ts` (`onAgentSdkMessage`/`onPermissionRequest`/`onPermissionResolved`/`onPermissionHandlerReady`/`onAbortReady`), `claudeRemoteLauncher.ts` (the tap calls), `permissionHandler.ts` (observer hooks + `resolveExternally`) — the proxy uses `runAcp`'s permission machinery, not the native `PermissionHandler`.

Keep: `src/utils/nodeToWebStreams.ts` (shared), the `runAcpAgent.ts` stdio/`AgentSideConnection` scaffolding (rewritten to build the proxy), and the `acp-agent` subcommand + non-interactive-auth guard in `index.ts`.

Rewrite: `HappyAcpAgent.ts` → the proxy `Agent` forwarder.

The `claudeRemoteLauncher.ts` loop-exit-on-closed-queue fix (from the deadlock work) is a genuine improvement to the shared launcher — **keep it** even though the native engine is removed.

## 5. Out of scope (Phase 2 / follow-ups)

- **Mobile tool-card enrichment** (the fidelity recovery): forward ACP `diff`/`kind`/`locations`/`rawOutput`/tool-results in the relay + add app-side `kind`-based views (incl. a `file-edit` diff view the app already half-supports). Benefits every agent. Separate design.
- **Claude subagent/Task fan-out trees** on mobile — genuinely lossy through ACP; not recoverable in Phase 2.
- **Auto-install / manage downstream agents** — out; BYO means the user provides the agent.
- **Native-Claude drive** — removed; could return as an opt-in later if desired.

## 6. Risks / open questions

- **initialize timing:** Zed calls `initialize` before `newSession`. We must spawn the downstream and forward `initialize` at Happy's `initialize` (so we can return real downstream capabilities), then forward `newSession` when Zed sends it. Confirm the downstream tolerates spawn-at-initialize.
- **Two ACP versions negotiating:** Zed↔Happy and Happy↔downstream each negotiate `protocolVersion`. Forward Zed's version down and the downstream's response up; if they differ, pick the min and note it. Verify the SDK exposes the negotiated version.
- **Phone envelope mapping fidelity** is the accepted Phase-1 degradation; the tap must at least not crash on update types `AcpSessionManager` ignores.
- **Turn serialization across Zed + phone:** both feed the downstream; one prompt in flight (reuse `runAcp`'s queue + pending-turn). Confirm the downstream serializes or we serialize.
- **cancel semantics:** forward Zed `cancel` to downstream `cancel`; ensure a phone-initiated cancel path too.

## 7. Testing

- **Unit:** the forwarders (each `Agent`/`Client` method calls the opposite connection with mapped params); the phone-envelope tap (ACP `SessionUpdate` → `SessionEnvelope[]`); 3-party permission resolution (first-wins, both orders).
- **Integration (hermetic):** an in-memory Zed↔Happy pair + a **fake downstream** `Agent` (scripted `sessionUpdate`s/`requestPermission`), asserting Zed receives forwarded updates and the phone relay is called. Mirror the in-memory `ndJsonStream` pattern from `AcpBackend.test.ts` / our handshake test.
- **E2E (human):** `happy acp-agent -- npx @zed-industries/claude-code-acp` against a self-hosted server; drive from Zed, confirm pickers appear (forwarded), phone shows the session + can drive, permission prompts hit both, cancel works.

## 8. Delivery

Phase 1 (this doc): the proxy, replacing the native drive. Phase 2 (separate): mobile fidelity enrichment.
