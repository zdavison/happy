# Handover: add a desktop to the self-hosted Happy setup (Zed/ACP + phone control)

This sets up a **second machine** (your desktop) against the already-running
self-hosted Happy server, with the same Zed/ACP integration as the laptop:

```
Zed (desktop) ──ACP──► happy acp-agent (proxy) ──ACP──► claude-code-acp ──► claude
                              │
                              └──► happy.digger.ooo (your server) ──► phone
```

The proxy mirrors the editor session to your server, so your **phone can drive
or take over** a Zed turn. It's agent-generic — the same setup points at Codex
ACP later by swapping the downstream command.

**Server:** `https://happy.digger.ooo` (standalone Happy server on the Hetzner
k3s box). You do **not** touch the server for this — a desktop only pairs as a
client.

---

## 0. Prerequisites (on the desktop)

- **Node 20+** and **git**.
- **Claude Code** installed and logged in (`claude` on your PATH; drives Claude
  for the ACP adapter).
- Your **phone** with the Happy app already pointed at `https://happy.digger.ooo`
  and signed in — it's the device that **approves** the desktop pairing.

> Why the fork (not `npm i -g happy`): the `acp-agent` proxy command is a
> feature of **our fork** (`zdavison/happy`), not the published npm release. You
> must build the CLI from the fork.

---

## 1. Clone the fork and build the CLI

```bash
git clone https://github.com/zdavison/happy.git ~/github/happy
cd ~/github/happy
corepack enable                    # provides pnpm
pnpm install
pnpm --filter happy-cli build      # builds packages/happy-cli/dist (this is what has acp-agent)
```

Sanity check the build carries `acp-agent`:

```bash
node ~/github/happy/packages/happy-cli/bin/happy.mjs acp-agent 2>&1 | head -1
# Expect a usage/arg error about a downstream agent — NOT "unknown command".
```

> The `acp-agent` code lives on the fork's `main` branch. If you ever see the
> command behave oddly, rebuild — a stale `dist/` running old code was a real
> gotcha during initial setup.

---

## 2. Install the Claude ACP adapter

The proxy's downstream is the Claude ACP adapter. Install it globally so Zed
doesn't re-fetch it on every launch:

```bash
npm i -g @zed-industries/claude-code-acp
which claude          # note this path — needed for the Zed PATH below
which node            # note this too — Zed `command`
```

---

## 3. Point the CLI at the server

Create `~/.happy/settings.json`:

```json
{
  "serverUrl": "https://happy.digger.ooo",
  "webappUrl": "https://happy.digger.ooo"
}
```

This makes every Happy process on this machine (CLI, daemon, acp-agent) use your
server. Keep the default home dir `~/.happy` — don't set `HAPPY_HOME_DIR`.

---

## 4. Pair the desktop to your account

```bash
~/github/happy/packages/happy-cli/bin/happy.mjs
```

- It prints a **QR code**. **Scan it with your phone** — the phone approves,
  because it's the authenticated device on the account.
- Wait until the CLI confirms it's authenticated (don't Ctrl-C early).

This joins the desktop to your **existing account** (same as the phone/laptop) —
it uses the QR-approve flow, so it works even though new-account registration is
locked on the server. No server change needed.

---

## 5. Register the machine (so the phone can drive it)

```bash
~/github/happy/packages/happy-cli/bin/happy.mjs daemon start
~/github/happy/packages/happy-cli/bin/happy.mjs doctor
```

`doctor` should show:
- **Server URL:** `https://happy.digger.ooo`
- **Authentication:** ✓ (has credentials)
- **Daemon:** ✓ running

The desktop now appears as a machine in the phone app.

---

## 6. Zed `agent_servers` config

In Zed settings (`agent_servers`), fill the bracketed values from the paths you
noted in step 2:

```json
"Happy": {
  "command": "<which node>",
  "args": [
    "<HOME>/github/happy/packages/happy-cli/bin/happy.mjs",
    "acp-agent",
    "--",
    "claude-code-acp"
  ],
  "type": "custom",
  "env": {
    "HAPPY_SERVER_URL": "https://happy.digger.ooo",
    "PATH": "<dir of `which claude`>:<dir of `which node`>:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  }
}
```

Substitutions (differ per machine — that's the whole point of this step):
- `command` → output of `which node`.
- The `happy.mjs` path → your clone location.
- **`PATH` must include the directory of `which claude`** — the proxy spawns
  `claude` and it must resolve, or the downstream fails.

Restart the Happy agent in Zed. It should connect; drive Claude from the panel,
and your phone can take over a turn.

---

## Troubleshooting (issues we actually hit)

| Symptom | Cause | Fix |
|---|---|---|
| Zed: `acp-agent error: Usage: happy acp <agent-name> ...` | `acp-agent` needs a downstream; bare `acp-agent` no longer works | Use the `-- claude-code-acp` form as in step 6 |
| Zed: `nvm: Can't use Node "latest" ...` then exit 1 | `claude` not on the Zed `PATH`, so a fallback tries nvm | Add the `which claude` dir to `PATH` in the Zed `env` |
| `acp-agent` behaves like old code | stale `dist/` | `pnpm --filter happy-cli build` again |
| `happy doctor` → "Not authenticated" | pairing didn't complete / wrong home dir | Re-run step 4, scan with the phone, let it finish; ensure no `HAPPY_HOME_DIR` override |
| Phone "pairing successful" but CLI keeps waiting | phone is on a **different server** than the CLI | Confirm the phone's server is `https://happy.digger.ooo`, restart the app, re-scan |
| Machine doesn't appear in the app | daemon not running / not on your server | `happy daemon start`; check `happy doctor` shows the server + daemon ✓ |

---

## Reference

- **Server:** `https://happy.digger.ooo` (health: `GET /health` → 200)
- **Account:** same as your phone + laptop (one account, many machines)
- **Home dir:** `~/.happy` (credentials in `~/.happy/access.key`, settings in
  `~/.happy/settings.json`)
- **CLI entrypoint:** `~/github/happy/packages/happy-cli/bin/happy.mjs`
- **Registration is locked** on the server (drive-bys blocked). Adding this
  desktop does **not** require reopening it — pairing to the existing account
  goes through the QR-approve flow, which isn't gated. Adding a brand-new
  *account* (not a device) is what's blocked.
- Same setup works for **Codex** later: swap `claude-code-acp` for the Codex ACP
  command after `--`.
