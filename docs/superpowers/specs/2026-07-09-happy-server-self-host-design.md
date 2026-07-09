# Self-Hosted happy-server on the digger.ooo Hetzner box

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan
**Repos involved:** `zdavison/happy` (fork, this repo) and `digger.ooo` (infra repo on the Hetzner box)

## Goal

Run our own happy-server so we can use the happy mobile app **away from home**, driving
Claude/coding agents running on our **home computer**. The server is deployed into a
dedicated Kubernetes namespace on the existing single-node k3s box that already hosts
`digger.ooo`.

## Why this works

happy-server is an end-to-end-encrypted **relay**. The topology is:

```
mobile app  ⇄  happy-server (Hetzner, public: happy.digger.ooo)  ⇄  happy CLI (home computer)
```

The home computer **dials out** to the server over a websocket; it is never publicly
exposed. The Hetzner box is only the encrypted rendezvous point. Encryption keys live on
the devices, so the server only ever handles ciphertext — the security model is identical
to the hosted cloud server whether or not we self-host.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Deployment mode | **Standalone** (PGlite + local files) | No Redis/Postgres/S3 to run; matches single-node, single-replica box; happy's supported self-host path |
| Image distribution | **Public GHCR image**, built by GH Actions in the fork | No registry auth/imagePullSecret needed; clean pull-based deploys; keeps CI in the fork |
| Web client | **Not served** | Goal is the mobile app; the app switches server in-app with no rebuild. Can add later. |
| Drive-by protection | **Public-key allowlist** on `POST /v1/auth` (fork patch) | Needs nothing from the clients; travel-proof (no IPs); ~5-line change |
| k8s manifests | New `happy` namespace under `digger.ooo` repo `infra/k8s/happy/` | Mirrors the existing `monitoring/` second-namespace pattern |
| Hostname | `happy.digger.ooo` | Reuses Traefik + cert-manager already on the box |

### Deployment mode: Standalone

Single pod running the root `Dockerfile` (standalone image). PGlite embedded Postgres +
local filesystem storage under `/data`, backed by a `local-path` PVC. No Redis, Postgres,
or S3. The image's CMD runs migrations then serves:
`tsx sources/standalone.ts migrate && exec tsx sources/standalone.ts serve`.
HTTP + Socket.IO share port **3005**; Socket.IO path is `/v1/updates`; health endpoint is
`GET /health`. `replicas: 1` (local-path RWO PVC, matches every other app on the box).

### Image: public GHCR, built in the fork

- New GitHub Actions workflow in `zdavison/happy` (alongside the existing
  `cli-smoke-test.yml`, `typecheck.yml`) builds the root `Dockerfile` from the monorepo
  root and pushes `ghcr.io/zdavison/happy-server:<tag>`.
- The GHCR package is marked **Public**, so k3s pulls it with **no imagePullSecret**.
- Tag strategy: pin to an immutable tag (git SHA or version), not `:latest`, so redeploys
  are explicit. Redeploy = build new tag → bump the tag in the Deployment → `kubectl -n
  happy rollout restart deploy/happy-server` (or `set image`).

### Security: public-key registration allowlist

happy-server has **open registration** — anyone who reaches the endpoint can
`POST /v1/auth` with a fresh keypair and create an account, freeloading on the box. E2E
encryption protects our *data's confidentiality* but does **not** stop abuse.

Why not a proxy token / basic auth: the stock happy clients cannot carry one. The websocket
auth token lives inside the Socket.IO **handshake payload** (`socket.handshake.auth.token`),
not in any HTTP URL/header a proxy can inspect; a path-secret in `serverUrl` breaks the
Socket.IO namespace; and React Native's WebSocket strips URL credentials. So any
proxy-level token gate would break the mobile socket.

Why the allowlist works: the client **already** sends its public key during registration
(`POST /v1/auth` body is `{ challenge, publicKey, signature }`). We check that key against
an allowlist **server-side**, requiring nothing new from the client.

Why one endpoint is enough: `POST /v1/auth` (`db.account.upsert`) is the only way to
bootstrap a brand-new account. The pairing endpoints (`/v1/auth/response`,
`/v1/auth/account/response`) require `app.authenticate` — an already-authorized account
must approve — so they are self-gating.

The patch, in `packages/happy-server/sources/app/api/routes/authRoutes.ts`, after the
signature verification and before the `db.account.upsert`:

```ts
const allow = (process.env.HAPPY_ALLOWED_PUBLIC_KEYS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (allow.length && !allow.includes(publicKeyHex.toLowerCase())) {
    return reply.code(403).send({ error: 'Registration not allowed' });
}
```

Behavior: if `HAPPY_ALLOWED_PUBLIC_KEYS` is unset/empty, registration is open (needed for
first-boot bootstrap). Once set, only the listed public keys can create accounts.

**Bootstrap sequence:** deploy with the allowlist empty → pair the home CLI and the mobile
app once (the server already logs each `publicKey` hex on `/v1/auth/request`) → copy the
key(s) into `HAPPY_ALLOWED_PUBLIC_KEYS` in the secret → redeploy closed. From then on it is
both travel-proof (no IP dependence) and drive-by-proof.

## Kubernetes layout

New namespace `happy`, manifests under `digger.ooo` repo `infra/k8s/happy/`, applied
namespace-first (the `monitoring/` pattern):

```
infra/k8s/happy/
  namespace.yaml     # namespace: happy
  pvc.yaml           # local-path, ~20Gi, RWO, for /data (PGlite + files)
  deployment.yaml    # ghcr.io/zdavison/happy-server:<tag>, port 3005,
                     #   /health probes, /data mount, envFrom secret happy-secrets
  service.yaml       # ClusterIP :3005
  ingress.yaml       # host happy.digger.ooo, traefik, cert-manager cluster-issuer
                     #   letsencrypt, tls secretName happy-digger-ooo-tls, backend :3005
```

The `ingress.yaml` is a copy of the existing `infra/k8s/api-ingress.yaml` with the host,
tls secret name, and backend service/port swapped. The `letsencrypt` ClusterIssuer is
cluster-scoped and already installed, so the new namespace references it directly.

### Secrets (box-local, imperative — the digger pattern)

Create a plaintext env file on the box and load it as a k8s Secret (never in git):

```
kubectl -n happy create secret generic happy-secrets \
  --from-env-file=/mnt/HC_Volume_106223433/secrets/happy.env
```

`happy.env` contents:

| Var | Value / notes |
|---|---|
| `HANDY_MASTER_SECRET` | Stable, critical. Seeds auth-token generation. Changing it invalidates all tokens (forces re-pairing). |
| `PUBLIC_URL` | `https://happy.digger.ooo` — used to build file URLs handed to clients |
| `HAPPY_ALLOWED_PUBLIC_KEYS` | Comma-separated device public-key hex; empty during bootstrap |

Non-secret env (`PORT=3005`, `DATA_DIR=/data`, etc.) come from the image defaults / the
Deployment `env` block.

### DNS & TLS

Add an A record `happy.digger.ooo → 91.98.45.208`. On first `kubectl apply`, cert-manager
solves the HTTP-01 challenge through Traefik and mints the TLS cert automatically.

### Networking

Public surface stays exactly as today: Traefik `:80` (ACME + redirect) and `:443` (HTTPS
ingress). happy-server's Service is ClusterIP — reachable publicly only through the
Ingress. No new firewall rules.

## Client configuration

- **Home computer CLI:** `HAPPY_SERVER_URL=https://happy.digger.ooo` (env var, or
  `serverUrl` in `~/.happy/settings.json`).
- **Mobile app:** in-app server-switch screen → `https://happy.digger.ooo`. No App Store
  rebuild required.

## End-to-end deploy flow

1. Add DNS A record `happy.digger.ooo → 91.98.45.208`.
2. Land the allowlist patch + GH Actions workflow in the `zdavison/happy` fork; Actions
   builds and pushes the public GHCR image.
3. Write `infra/k8s/happy/` manifests in the `digger.ooo` repo; `git pull` on the box.
4. Create `/mnt/HC_Volume_106223433/secrets/happy.env` (allowlist empty for now) and the
   `happy-secrets` Secret.
5. `kubectl apply -f infra/k8s/happy/namespace.yaml` then `kubectl apply -f infra/k8s/happy/`.
   cert-manager issues the cert; Traefik routes `happy.digger.ooo`.
6. Point the CLI and mobile app at `https://happy.digger.ooo`; pair devices.
7. Read the paired public keys from the server logs; set `HAPPY_ALLOWED_PUBLIC_KEYS` in
   the secret; redeploy (`rollout restart`) to close registration.

## Non-goals

- No web client hosting (mobile app only for now).
- No Postgres/Redis/S3/HA — standalone single-pod is intentional for personal use.
- No container registry beyond the public GHCR package (no self-hosted registry).
- No Tailscale/VPN or IP allowlisting — rejected in favor of the app-level key allowlist
  because we travel and need location independence.

## Risks / open items

- **PVC durability:** `local-path` PVC lives on the box's volume; standalone data (PGlite +
  files) is not replicated. Acceptable for personal use; back up `/data` if desired.
- **Fork maintenance:** the allowlist patch is a small carry against upstream `slopus/happy`.
- **Home-IP stability:** not applicable — the allowlist design deliberately avoids IPs.
- **Media deps:** the standalone image already bundles ffmpeg; no extra host setup needed.
