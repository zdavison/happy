# Happy ACP Agent — End-to-End Test Plan (self-hosted, phone-in-the-loop)

**Goal:** Prove the acceptance scenario from the design spec on real infrastructure: point Zed at `happy acp-agent`, drive Claude from the panel, take control on the phone for a turn, then take it back in Zed — the panel re-renders the full thread the phone advanced, with no restart, and a permission prompt follows the active client.

**Why self-host:** the phone and the `happy acp-agent` process must share **one Claude session on one server under one account**. The public server can't see a locally-spawned `acp-agent`, so we run the whole stack on the laptop and pair the phone into it.

**Design under test:** `docs/superpowers/specs/2026-07-03-happy-acp-agent-surface-design.md`. The branch is `feat/happy-acp-agent`.

---

## The one rule that makes it work (read first)

For the editor and phone to share a session, **four things must agree**: the running **server**, the **account** (credentials), the CLI's **`HAPPY_SERVER_URL`/`HAPPY_HOME_DIR`**, and the phone app's **Server Config**. If any of them drifts (phone on prod, CLI on localhost, Zed using a different home dir), you get two *unrelated* sessions and the test silently "fails" by showing nothing on the phone.

```
        laptop (one machine)                              phone
  ┌───────────────────────────────────┐          ┌──────────────────┐
  │  happy-server (standalone/PGlite)  │◀────────▶│  Happy app       │
  │  http://localhost:PORT             │  same    │  Server Config = │
  │        ▲            ▲              │  server  │  <reachable URL> │
  │        │ relay      │ relay        │  + same  │  paired to same  │
  │  ┌─────┴─────┐  ┌───┴──────────┐   │  account │  account (QR)    │
  │  │ Zed panel │  │ acp-agent    │   │          └──────────────────┘
  │  │  (ACP     │──│ (node bin/   │   │
  │  │  stdio)   │  │  happy.mjs)  │   │   HAPPY_SERVER_URL + HAPPY_HOME_DIR
  │  └───────────┘  └──────────────┘   │   must match the ones you logged in with
  └───────────────────────────────────┘
```

---

## Landmines (each has sunk this exact kind of test)

1. **`HAPPY_VARIANT=dev` corrupts the ACP channel.** With `HAPPY_VARIANT=dev`, the CLI prints a "DEV MODE" banner **to stdout** (`packages/happy-cli/src/configuration.ts:72-73`). For `acp-agent`, stdout is the JSON-RPC wire — the banner makes Zed fail to parse. **The repo's own `env:*` tooling sets `HAPPY_VARIANT=dev`.** So do NOT reuse the generated `env.sh` verbatim for the Zed-spawned process. The Zed `env` block must NOT contain `HAPPY_VARIANT=dev`.
2. **The phone can't reach `localhost`.** The `env:*` tooling bakes `http://localhost:PORT` into the app config. A physical phone needs a LAN IP or a Tailscale URL. Override it in the app's **Server Config** screen (no rebuild).
3. **`acp-agent` needs prior auth *and* a machineId in the same home dir.** It calls `readCredentials()` and exits to stderr if unauthenticated (`index.ts:403-407`); the engine also requires `settings.machineId` (`engine.ts:75-77`). Running interactive `happy` once provisions both. Whatever `HAPPY_HOME_DIR` you authenticate under is the one Zed must pass.
4. **Zed doesn't inherit your shell PATH.** Use an absolute `node` in the command (or put `node`/tools on `PATH` in the `env` block), else `node` or tools Claude spawns won't resolve.
5. **You must rebuild the CLI.** `bin/happy.mjs` runs the compiled `dist/`, not TypeScript — branch changes require `pnpm run build`.
6. **App Store app is fine; watch the transport for non-LAN addresses.** No mobile-app changes were made, and production ATS allows plain HTTP to **private LAN IPs** (`NSAllowsLocalNetworking: true`, `app.config.js:86-88`), so the App Store app works over same-Wi-Fi LAN and over Tailscale **Funnel HTTPS**. It will *not* do plain HTTP to a non-private address (e.g. a raw Tailscale `100.x` IP) — use the Funnel HTTPS URL there, or a dev/preview build (`NSAllowsArbitraryLoads`).

---

## Prerequisites

- Node 20 (repo's de-facto version; `Dockerfile` uses `node:20`, no `.nvmrc`).
- `pnpm` (repo pins `pnpm@10.11.0`), deps installed at repo root (`pnpm install`).
- Zed with the Agent Panel (ACP `agent_servers` support).
- **The Happy app from the App Store is fine** — this feature made **zero mobile-app changes** (all changes are in `packages/happy-cli`), and the app renders/drives an `acp-agent` session exactly like a `happy claude` session. The App Store (production) build can point at a self-hosted server: the in-app **Server Config** screen (`/server`) is not dev-gated, and production ATS sets `NSAllowsLocalNetworking: true` (`app.config.js:86-88`), which permits plain HTTP to **private LAN IPs** (192.168.x.x). A dev/preview build is only needed if you must hit a non-private HTTP address (e.g. a raw Tailscale `100.x` IP over HTTP — avoidable by using the Tailscale **Funnel HTTPS** URL instead).
- Claude Code working locally (the SDK spawns `claude`), and phone + laptop able to reach each other (same Wi-Fi, or Tailscale).
- Decide the phone-reachability path now: **(A) LAN** (same Wi-Fi, laptop IP) or **(B) Tailscale Funnel** (works anywhere, HTTPS). B is more robust; A is simpler if both are on the same network.

---

## Phase 0 — Build the branch CLI

```bash
cd /Users/z/github/happy
git checkout feat/happy-acp-agent
pnpm install
pnpm --filter happy-cli run build      # produces packages/happy-cli/dist
```
Sanity: `node packages/happy-cli/bin/happy.mjs --version` prints a version.
**Proves:** the branch builds and the bin runs.

---

## Phase 1 — Run the server locally (standalone, zero external deps)

Standalone mode uses embedded PGlite — no Postgres/Redis/S3. Pick a fixed port so every other component can point at it deterministically.

```bash
cd /Users/z/github/happy/packages/happy-server
# .env.dev already sets HANDY_MASTER_SECRET + PORT (3005). To bind for LAN access:
HOST=0.0.0.0 PORT=3005 pnpm standalone:dev
```
- Health check (laptop): `curl -s http://localhost:3005/` → returns a "Welcome to Happy Server!" body.
- Note the URL the *laptop-side* components use: **`http://localhost:3005`** (server config: `standalone.ts`, `configuration.ts:56-59`).

**Proves:** the server boots and is reachable locally. Leave it running in its own terminal.

> Alternative (more automated, but sets the landmine-1 var): `pnpm env:up:authenticated` spins up server+web+seeded-CLI on auto-allocated ports. If you use it, read the printed server port and **strip `HAPPY_VARIANT=dev`** before using its env for `acp-agent`.

---

## Phase 2 — Make the server reachable by the phone

Pick the path you chose in Prerequisites.

**Path A — LAN (same Wi-Fi):**
```bash
ipconfig getifaddr en0        # your laptop LAN IP, e.g. 192.168.1.42
curl -s http://192.168.1.42:3005/     # from the laptop, confirm it answers on the LAN IP
```
Phone-reachable server URL = `http://<laptop-ip>:3005`. (Server was started with `HOST=0.0.0.0` in Phase 1.)

**Path B — Tailscale Funnel (HTTPS, anywhere):**
```bash
cd /Users/z/github/happy
pnpm env:tailscale     # requires an active env + Tailscale Funnel enabled
# prints: Server https://<your-host>.ts.net:8443
```
Phone-reachable server URL = `https://<your-host>.ts.net:8443`. (Requires Tailscale running and Funnel enabled; `environments.ts` `commandTailscale`.)

**Proves:** the phone can hit the same server the laptop runs. Test from the phone's browser: open the URL → "Welcome to Happy Server!".

---

## Phase 3 — Authenticate the CLI and pair the phone (same account, same server)

Use a **dedicated, isolated home dir** so this test can't collide with your real `~/.happy`. Export the same two vars in every CLI/agent invocation from here on.

```bash
export HAPPY_HOME_DIR="$HOME/.happy-acp-test"
export HAPPY_SERVER_URL="http://localhost:3005"       # laptop-side URL (NOT the phone URL)
```

1. Start an interactive login (this provisions credentials **and** machineId):
   ```bash
   node /Users/z/github/happy/packages/happy-cli/bin/happy.mjs
   ```
   Choose the mobile/QR auth option; the CLI renders a `happy://terminal?…` QR (`ui/auth.ts:102`, `ui/qrcode.ts`).
2. On the phone: open the app → **Server Config** screen (`/server`) → set it to the **phone-reachable** URL from Phase 2 (`http://<laptop-ip>:3005` or the Tailscale `https://…:8443`). Save; it must validate ("Welcome to Happy Server!"). (`packages/happy-app/sources/app/(app)/server.tsx`.)
3. In the app, **Connect Terminal** → scan the CLI's QR. The QR carries only the CLI's public key, so approval only works because the app is now on the **same server** (`hooks/useConnectTerminal.ts`, `auth/authApprove.ts`). The CLI login completes.

**Proves:** phone and CLI share one account on your server. This is the single most failure-prone step — do not proceed until the CLI login says authorized.

Confirm machine setup: `node …/bin/happy.mjs daemon status` (with the two env vars exported) shows a registered machine.

---

## Phase 4 — Bisection smoke test: `happy claude` before Zed

Before involving Zed/ACP, prove phone↔CLI on a **plain** session. This isolates "server + pairing" from "the ACP feature."

```bash
# same terminal, HAPPY_HOME_DIR + HAPPY_SERVER_URL still exported
cd /some/test/project
node /Users/z/github/happy/packages/happy-cli/bin/happy.mjs claude
```
- Send a prompt in the terminal; watch Claude respond.
- On the phone: the session appears; open it — you see the live thread.
- From the phone: send a prompt; the terminal/session advances (phone drives).

**If this fails, STOP** — the problem is server/pairing/reachability (Phases 1-3), not the ACP feature. Fix here first. **If it works,** your infrastructure is sound and any remaining failure is in `acp-agent`.

---

## Phase 5 — Point Zed at `happy acp-agent`

Add to Zed `settings.json`. **Verify this shape against current Zed `agent_servers` docs — it is not defined in this repo**, only Zed's ACP client format.

```jsonc
{
  "agent_servers": {
    "Happy": {
      "command": "/absolute/path/to/node",              // absolute — Zed won't inherit PATH (landmine 4)
      "args": [
        "/Users/z/github/happy/packages/happy-cli/bin/happy.mjs",
        "acp-agent"
      ],
      "env": {
        "HAPPY_SERVER_URL": "http://localhost:3005",     // laptop-side URL, SAME server as Phase 3
        "HAPPY_HOME_DIR": "/Users/<you>/.happy-acp-test", // SAME home you authenticated in Phase 3
        "PATH": "/usr/local/bin:/usr/bin:/bin"            // so `node` and `claude` resolve
        // DO NOT set HAPPY_VARIANT=dev — it prints a banner to stdout and breaks JSON-RPC (landmine 1)
      }
    }
  }
}
```

Notes:
- `HAPPY_SERVER_URL` here is the **laptop** URL (`localhost:3005`) because `acp-agent` runs on the laptop — same server instance the phone reaches via its own URL.
- `HAPPY_HOME_DIR` must be exactly the Phase 3 home dir, or `acp-agent` won't be authenticated.
- Reload Zed; "Happy" should appear in the Agent Panel as a selectable agent.

**Quick pre-check (before using the panel), from a laptop terminal:**
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
  | HAPPY_HOME_DIR="$HOME/.happy-acp-test" HAPPY_SERVER_URL="http://localhost:3005" \
    node /Users/z/github/happy/packages/happy-cli/bin/happy.mjs acp-agent 2>/dev/null | head -1
```
Expected: a single JSON line with `"protocolVersion":1` and nothing else on stdout. If you see any banner/log text, fix the env (landmine 1) before trying Zed.

**Proves:** Zed can spawn and handshake with the agent, and stdout is clean.

---

## Phase 6 — The acceptance test

Open a project in Zed, pick the **Happy** agent in the panel, and run the scenario:

1. **Drive from the panel.** Send "list the files in this project and summarize the README." Expect streamed assistant text (`agent_message_chunk`), tool calls rendering (`tool_call` → `tool_call_update`), turn completes. (`HappyAcpAgent.onSdkMessage` → `connection.sessionUpdate`.)
2. **Confirm the phone sees it.** The same session appears in the Happy app (the engine created a server session, `engine.ts:90`). Open it — the full thread is there.
3. **Take control on the phone.** Send a prompt from the phone (e.g. "now count the TODO comments"). The phone's message enters the *same* queue (`engine.ts:127-133` `onUserMessage`), Claude runs, and **Zed's panel advances** with the phone-driven turn's updates (unsolicited `session/update`s).
4. **Take it back in Zed.** Send another prompt from the panel. Confirm it continues with full context from the phone turn — **no restart, no lost history**.
5. **Permission follows the active client.** Trigger a tool needing approval (e.g. "run `git status`") while driving from Zed → an Allow/Deny prompt appears **in Zed** (`requestPermission`); approve it there. Then trigger one while the phone is active → it appears on the phone; either client's answer resolves it (first-answer-wins, `resolveExternally`).
6. **Cancel.** Start a long turn from Zed, hit stop/cancel → the running turn is interrupted (`cancel` → `engine.abort()` → real abort), not just "queue cleared."
7. **Teardown.** Close the panel / quit Zed → the connection aborts → `dispose()` runs; the Happy session closes cleanly and the temp hook-settings file is removed (no leak, no busy-loop).

**Success = all 7 hold.** The headline (steps 3-4) is the whole point: one session, driven from either side, control handed back by typing, no restart.

---

## Failure signatures → where to look

| Symptom | Likely cause | Fix |
|---|---|---|
| Zed shows JSON-parse errors / agent won't start | Something wrote to stdout | Remove `HAPPY_VARIANT=dev`; check no stray logs (landmine 1) |
| Agent exits immediately; Zed logs "not authenticated" (stderr) | `HAPPY_HOME_DIR` mismatch / not logged in | Re-check Phase 3 home dir; ensure Zed's `HAPPY_HOME_DIR` matches |
| "No machine ID found in settings" | Credentials exist but machine never registered | Run interactive `happy` once in that home dir (not just `auth`) |
| Panel works, but nothing on the phone | Phone on a different server/account | Phone Server Config must equal the same server; re-pair (Phase 3) |
| Phone can't load Server Config URL | `localhost` baked in / no reachability | Use LAN IP (App Store app OK over private-LAN HTTP) or Tailscale Funnel HTTPS (landmines 2, 6) |
| `node`/`claude` not found when Zed spawns it | PATH not inherited | Absolute `node` in `command`; add `PATH`/tool dirs to `env` (landmine 4) |
| Phase 4 (`happy claude`) already fails | Infra, not the feature | Fix server/pairing before touching Zed |

---

## What I can do now vs. what needs you

**I can drive on this laptop (no phone/Zed needed):** Phase 0 (build), Phase 1 (start standalone server), and a headless-handshake smoke of `acp-agent` (the Phase 5 pre-check) against the local server with a throwaway authenticated home — to confirm the server + engine bootstrap + ACP handshake all light up before you bring the phone and Zed in.

**Needs you (physical devices / GUI):** the phone pairing (Phase 3), the Server Config screen, Zed's `settings.json`, and the interactive acceptance run (Phase 6).

Say the word and I'll start the server and run the machine-side smoke.
