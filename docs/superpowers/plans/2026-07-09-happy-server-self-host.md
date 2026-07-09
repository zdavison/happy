# Self-Hosted happy-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy our own happy-server (standalone mode) into a dedicated `happy` Kubernetes namespace on the existing single-node k3s Hetzner box, reachable at `https://happy.digger.ooo`, so the mobile app can drive agents on the home computer from anywhere.

**Architecture:** happy-server runs as a single standalone pod (PGlite + local files on a `local-path` PVC), image pulled from a public GHCR package built by GitHub Actions in the `zdavison/happy` fork. Traefik + cert-manager (already on the box) front it with TLS. Drive-by registration is blocked by a public-key allowlist patched into the fork's `POST /v1/auth` handler.

**Tech Stack:** Node 20, Fastify 5, Socket.IO, Prisma + PGlite (standalone), Vitest, pnpm 10.11.0, Docker/GHCR, GitHub Actions, k3s, Traefik, cert-manager.

**Spec:** `docs/superpowers/specs/2026-07-09-happy-server-self-host-design.md`

**Repos:**
- **Fork** = `zdavison/happy` (this repo, `/Users/z/github/happy`) — Tasks 1–3.
- **Infra** = `digger.ooo` (`/Users/z/github/digger.ooo`, checked out on the box at `/mnt/HC_Volume_106223433/digger`) — Tasks 4–6.

## Global Constraints

- **Runtime:** Node.js 20; package manager **pnpm** (never npm).
- **Indentation:** 4 spaces (not 2).
- **Imports:** absolute with `@/` prefix for cross-module imports inside `happy-server`; sibling files in a spec may use relative imports (matches `separateName.spec.ts`).
- **Style:** functional, avoid classes; prefer `interface` over `type`.
- **Base64/hex:** always use `privacyKit.decodeBase64` / `privacyKit.encodeBase64` / `privacyKit.encodeHex` (never raw Buffer).
- **Tests:** Vitest, `.spec.ts` suffix; write the util test before the util.
- **Do not** add logging unless required; **do not** create Prisma migrations by hand.
- **Image tag:** `ghcr.io/zdavison/happy-server:latest`, Deployment uses `imagePullPolicy: Always`.
- **Server facts:** listens on `PORT` (default `3005`), health at `GET /health`, Socket.IO path `/v1/updates`. Standalone image sets `DATA_DIR=/data`, `PGLITE_DIR=/data/pglite`, `NODE_ENV=production`, `EXPOSE 3005`, `VOLUME /data`.
- **Box facts:** public IP `91.98.45.208`; k3s with bundled Traefik (`ingressClassName: traefik`) + `local-path` storage; cert-manager `ClusterIssuer` named `letsencrypt` already installed; secrets dir `/mnt/HC_Volume_106223433/secrets/`.

---

## Task 1: Registration allowlist utility (TDD)

**Repo:** Fork (`/Users/z/github/happy`)

**Files:**
- Create: `packages/happy-server/sources/utils/isRegistrationAllowed.ts`
- Test: `packages/happy-server/sources/utils/isRegistrationAllowed.spec.ts`

**Interfaces:**
- Produces: `isRegistrationAllowed(publicKeyHex: string, allowlistEnv: string | undefined): boolean` — returns `true` when the env is empty/unset (open registration for bootstrap), otherwise `true` only if `publicKeyHex` (case-insensitive) is in the comma-separated allowlist.

- [ ] **Step 1: Write the failing test**

Create `packages/happy-server/sources/utils/isRegistrationAllowed.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isRegistrationAllowed } from './isRegistrationAllowed';

describe('isRegistrationAllowed', () => {
    const KEY = 'a1b2c3';

    it('allows any key when the allowlist is undefined (bootstrap)', () => {
        expect(isRegistrationAllowed(KEY, undefined)).toBe(true);
    });

    it('allows any key when the allowlist is empty string', () => {
        expect(isRegistrationAllowed(KEY, '')).toBe(true);
    });

    it('allows any key when the allowlist is only whitespace/commas', () => {
        expect(isRegistrationAllowed(KEY, '  , ,')).toBe(true);
    });

    it('allows a key that is in the allowlist', () => {
        expect(isRegistrationAllowed(KEY, 'a1b2c3')).toBe(true);
    });

    it('rejects a key that is not in the allowlist', () => {
        expect(isRegistrationAllowed(KEY, 'deadbeef')).toBe(false);
    });

    it('matches case-insensitively', () => {
        expect(isRegistrationAllowed('A1B2C3', 'a1b2c3')).toBe(true);
        expect(isRegistrationAllowed('a1b2c3', 'A1B2C3')).toBe(true);
    });

    it('trims whitespace around entries', () => {
        expect(isRegistrationAllowed(KEY, '  a1b2c3  ,  deadbeef ')).toBe(true);
    });

    it('supports multiple keys', () => {
        expect(isRegistrationAllowed('deadbeef', 'a1b2c3,deadbeef,cafe')).toBe(true);
        expect(isRegistrationAllowed('nope', 'a1b2c3,deadbeef,cafe')).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/happy-server && pnpm exec vitest run sources/utils/isRegistrationAllowed.spec.ts`
Expected: FAIL — cannot find module `./isRegistrationAllowed`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/happy-server/sources/utils/isRegistrationAllowed.ts`:

```ts
/**
 * Decides whether an account may be created for a given public key.
 *
 * The allowlist is supplied as a comma-separated list of public-key hex strings
 * (env var HAPPY_ALLOWED_PUBLIC_KEYS). When the allowlist is empty or unset,
 * registration is open — this is required for first-boot bootstrap, after which
 * the operator fills the allowlist and redeploys to lock registration down.
 */
export function isRegistrationAllowed(publicKeyHex: string, allowlistEnv: string | undefined): boolean {
    const allow = (allowlistEnv || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    if (allow.length === 0) {
        return true;
    }
    return allow.includes(publicKeyHex.toLowerCase());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/happy-server && pnpm exec vitest run sources/utils/isRegistrationAllowed.spec.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/utils/isRegistrationAllowed.ts packages/happy-server/sources/utils/isRegistrationAllowed.spec.ts
git commit -m "feat(server): add isRegistrationAllowed allowlist utility"
```

---

## Task 2: Enforce the allowlist in POST /v1/auth

**Repo:** Fork (`/Users/z/github/happy`)

**Files:**
- Modify: `packages/happy-server/sources/app/api/routes/authRoutes.ts` (import at top; check inserted between the `publicKeyHex` computation and the `db.account.upsert`, currently around lines 28–29)

**Interfaces:**
- Consumes: `isRegistrationAllowed` from Task 1.

- [ ] **Step 1: Add the import**

At the top of `packages/happy-server/sources/app/api/routes/authRoutes.ts`, add alongside the existing imports:

```ts
import { isRegistrationAllowed } from "@/utils/isRegistrationAllowed";
```

- [ ] **Step 2: Insert the allowlist gate**

In the `POST /v1/auth` handler, the code currently reads:

```ts
        // Create or update user in database
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const user = await db.account.upsert({
```

Change it to:

```ts
        // Create or update user in database
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        if (!isRegistrationAllowed(publicKeyHex, process.env.HAPPY_ALLOWED_PUBLIC_KEYS)) {
            return reply.code(403).send({ error: 'Registration not allowed' });
        }
        const user = await db.account.upsert({
```

- [ ] **Step 3: Typecheck / build**

Run: `cd packages/happy-server && pnpm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Boot-smoke the standalone server with a locked allowlist**

Run (from `packages/happy-server`):

```bash
HANDY_MASTER_SECRET=dev-smoke-secret \
HAPPY_ALLOWED_PUBLIC_KEYS=deadbeef \
DATA_DIR=/tmp/happy-smoke \
pnpm exec tsx sources/standalone.ts migrate && \
HANDY_MASTER_SECRET=dev-smoke-secret \
HAPPY_ALLOWED_PUBLIC_KEYS=deadbeef \
DATA_DIR=/tmp/happy-smoke \
pnpm exec tsx sources/standalone.ts serve &
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3005/health
```

Expected: `200` from `/health` (server boots with the patch and the allowlist env set). Stop the server afterward: `kill %1`. (The definitive 403-on-unknown-key path is exercised end-to-end during pairing in Task 6; the allowlist logic itself is unit-tested in Task 1.)

- [ ] **Step 5: Commit**

```bash
git add packages/happy-server/sources/app/api/routes/authRoutes.ts
git commit -m "feat(server): gate account creation with HAPPY_ALLOWED_PUBLIC_KEYS allowlist"
```

---

## Task 3: GitHub Actions workflow to build & push the GHCR image

**Repo:** Fork (`/Users/z/github/happy`)

**Files:**
- Create: `.github/workflows/happy-server-image.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/happy-server-image.yml`:

```yaml
name: Build happy-server image

on:
  push:
    branches: [main]
    paths:
      - 'packages/happy-server/**'
      - 'packages/happy-wire/**'
      - 'Dockerfile'
      - '.github/workflows/happy-server-image.yml'
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile
          push: true
          tags: ghcr.io/zdavison/happy-server:latest
```

- [ ] **Step 2: Commit and push to the fork**

```bash
git add .github/workflows/happy-server-image.yml
git commit -m "ci: build and push standalone happy-server image to GHCR"
git push fork HEAD
```

- [ ] **Step 3: Trigger and verify the build**

The workflow runs on push to `main`, or trigger it manually against the current branch:

```bash
gh workflow run "Build happy-server image" --repo zdavison/happy --ref feat/self-host-happy-server
gh run watch --repo zdavison/happy $(gh run list --repo zdavison/happy --workflow "Build happy-server image" --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: the run completes green and `ghcr.io/zdavison/happy-server:latest` is published.

- [ ] **Step 4: Make the GHCR package public**

In GitHub → `zdavison` packages → `happy-server` → Package settings → Change visibility → **Public**. Then verify an unauthenticated pull works:

```bash
docker pull ghcr.io/zdavison/happy-server:latest
```

Expected: pull succeeds with no login.

---

## Task 4: Kubernetes manifests for the `happy` namespace

**Repo:** Infra (`/Users/z/github/digger.ooo`)

**Files (all created):**
- `infra/k8s/happy/namespace.yaml`
- `infra/k8s/happy/pvc.yaml`
- `infra/k8s/happy/deployment.yaml`
- `infra/k8s/happy/service.yaml`
- `infra/k8s/happy/ingress.yaml`

- [ ] **Step 1: Namespace**

Create `infra/k8s/happy/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: happy
```

- [ ] **Step 2: PVC**

Create `infra/k8s/happy/pvc.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: happy-data
  namespace: happy
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 20Gi
```

- [ ] **Step 3: Deployment**

Create `infra/k8s/happy/deployment.yaml`. `strategy: Recreate` is required: a single RWO PVC cannot be mounted by an old and new pod simultaneously, so a rolling update would deadlock.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: happy-server
  namespace: happy
  labels: { app: happy-server }
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: { app: happy-server }
  template:
    metadata:
      labels: { app: happy-server }
    spec:
      containers:
        - name: happy-server
          image: ghcr.io/zdavison/happy-server:latest
          imagePullPolicy: Always
          envFrom:
            - secretRef: { name: happy-secrets }
          env:
            - { name: PORT, value: "3005" }
            - { name: DATA_DIR, value: "/data" }
          ports:
            - { name: http, containerPort: 3005 }
          volumeMounts:
            - { name: data, mountPath: /data }
          readinessProbe:
            httpGet: { path: /health, port: 3005 }
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 12
          livenessProbe:
            httpGet: { path: /health, port: 3005 }
            initialDelaySeconds: 40
            periodSeconds: 15
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: happy-data }
```

- [ ] **Step 4: Service**

Create `infra/k8s/happy/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: happy-server
  namespace: happy
spec:
  selector: { app: happy-server }
  ports:
    - { name: http, port: 3005, targetPort: 3005 }
```

- [ ] **Step 5: Ingress** (copy of `infra/k8s/api-ingress.yaml`, host/service/tls swapped)

Create `infra/k8s/happy/ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: happy-server
  namespace: happy
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
spec:
  ingressClassName: traefik
  tls:
    - hosts: [happy.digger.ooo]
      secretName: happy-digger-ooo-tls
  rules:
    - host: happy.digger.ooo
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: happy-server
                port:
                  number: 3005
```

- [ ] **Step 6: Client-side validation**

Run (from `/Users/z/github/digger.ooo`):

```bash
kubectl apply --dry-run=client -f infra/k8s/happy/namespace.yaml
kubectl apply --dry-run=client -f infra/k8s/happy/
```

Expected: every object validates (`... created (dry run)`), no schema errors. (If `kubectl` isn't configured locally, run this on the box after Step 7's `git pull`.)

- [ ] **Step 7: Commit**

```bash
git add infra/k8s/happy/
git commit -m "feat(infra): happy-server namespace, deployment, service, ingress, pvc"
```

---

## Task 5: DNS, secret, and first deploy on the box

**Repo:** Infra / the Hetzner box (SSH: `root@91.98.45.208`)

**Prereq:** Tasks 3 (public image) and 4 (manifests committed & pushed) are done.

- [ ] **Step 1: Create the DNS A record**

At the `digger.ooo` DNS provider, add: `happy.digger.ooo  A  91.98.45.208`. Verify:

```bash
dig +short happy.digger.ooo
```

Expected: `91.98.45.208`.

- [ ] **Step 2: Pull the manifests onto the box**

```bash
ssh root@91.98.45.208 'cd /mnt/HC_Volume_106223433/digger && git pull'
```

Expected: the `infra/k8s/happy/` directory is present on the box.

- [ ] **Step 3: Generate a stable master secret and write the env file**

On the box, create `/mnt/HC_Volume_106223433/secrets/happy.env` (allowlist empty for bootstrap):

```bash
ssh root@91.98.45.208 'MS=$(openssl rand -hex 32); cat > /mnt/HC_Volume_106223433/secrets/happy.env <<EOF
HANDY_MASTER_SECRET=$MS
PUBLIC_URL=https://happy.digger.ooo
HAPPY_ALLOWED_PUBLIC_KEYS=
EOF
chmod 600 /mnt/HC_Volume_106223433/secrets/happy.env
echo "written"'
```

Expected: `written`. (`HANDY_MASTER_SECRET` must stay stable forever — changing it invalidates all issued tokens.)

- [ ] **Step 4: Create the namespace and the secret**

```bash
ssh root@91.98.45.208 'kubectl apply -f /mnt/HC_Volume_106223433/digger/infra/k8s/happy/namespace.yaml && \
  kubectl -n happy create secret generic happy-secrets \
    --from-env-file=/mnt/HC_Volume_106223433/secrets/happy.env'
```

Expected: `namespace/happy created` (or unchanged) and `secret/happy-secrets created`.

- [ ] **Step 5: Apply the rest of the manifests**

```bash
ssh root@91.98.45.208 'kubectl apply -f /mnt/HC_Volume_106223433/digger/infra/k8s/happy/'
```

Expected: pvc, deployment, service, ingress all `created`.

- [ ] **Step 6: Wait for the pod and check it is healthy**

```bash
ssh root@91.98.45.208 'kubectl -n happy rollout status deploy/happy-server --timeout=180s && \
  kubectl -n happy get pods'
```

Expected: rollout succeeds; pod `Running` and `1/1` ready (readiness probe hits `/health`). If it crashloops, inspect: `kubectl -n happy logs deploy/happy-server`.

- [ ] **Step 7: Verify TLS + public reachability**

Wait ~1–2 min for cert-manager to issue the cert, then:

```bash
ssh root@91.98.45.208 'kubectl -n happy get certificate'
curl -s -o /dev/null -w "%{http_code}\n" https://happy.digger.ooo/health
```

Expected: certificate `READY=True`; `curl` returns `200` over valid HTTPS.

---

## Task 6: Pair devices, then lock registration

**Repo:** Operational (home computer, phone, box)

**Prereq:** Task 5 complete — `https://happy.digger.ooo/health` returns 200.

- [ ] **Step 1: Point the home CLI at the server and pair**

On the home computer:

```bash
HAPPY_SERVER_URL=https://happy.digger.ooo happy
```

Follow the pairing flow (scan the QR with the mobile app). Expected: the CLI connects and a session appears in the app.

- [ ] **Step 2: Point the mobile app at the server**

In the Happy mobile app → server-switch screen → set server URL to `https://happy.digger.ooo`. Expected: the app reconnects to your server and shows the home-computer session.

- [ ] **Step 3: Read the paired public key(s) from the server logs**

```bash
ssh root@91.98.45.208 'kubectl -n happy logs deploy/happy-server | grep -i "publicKey hex" | tail -5'
```

Expected: one or more `publicKey hex: <hex>` lines. Collect the hex value(s) for your device(s).

- [ ] **Step 4: Lock the allowlist and redeploy**

Edit `/mnt/HC_Volume_106223433/secrets/happy.env` on the box, setting the collected key(s):

```bash
ssh root@91.98.45.208 'sed -i "s/^HAPPY_ALLOWED_PUBLIC_KEYS=.*/HAPPY_ALLOWED_PUBLIC_KEYS=<hex1>,<hex2>/" /mnt/HC_Volume_106223433/secrets/happy.env && \
  kubectl -n happy delete secret happy-secrets && \
  kubectl -n happy create secret generic happy-secrets --from-env-file=/mnt/HC_Volume_106223433/secrets/happy.env && \
  kubectl -n happy rollout restart deploy/happy-server && \
  kubectl -n happy rollout status deploy/happy-server --timeout=180s'
```

Expected: rollout succeeds. Replace `<hex1>,<hex2>` with the real keys from Step 3.

- [ ] **Step 5: Verify registration is now closed**

Confirm your already-paired devices still work (open the app, run a command). New account creation is now refused (403) for any key not in the allowlist — the existing devices are unaffected because they authenticate with their stored token, not by re-registering.

Expected: existing devices function normally; the drive-by door is shut.

---

## Self-Review

**Spec coverage:**
- Standalone mode → Task 4 (image, PVC, single pod) + Global Constraints. ✓
- Public GHCR image built in fork → Task 3. ✓
- Public-key allowlist gate → Tasks 1–2 (util + wiring) and Task 6 (bootstrap→lock). ✓
- `happy` namespace + manifests under `infra/k8s/happy/` → Task 4. ✓
- Box-local imperative secret → Task 5 Steps 3–4. ✓
- DNS A record + cert-manager TLS → Task 5 Steps 1, 7. ✓
- Client config (CLI + mobile) → Task 6 Steps 1–2. ✓
- `:latest` + `imagePullPolicy: Always` → Global Constraints, Task 3, Task 4 Step 3. ✓
- No webapp hosting → not built (Non-goal); no task adds it. ✓

**Placeholder scan:** `<hex1>,<hex2>` in Task 6 are intentional runtime values captured in Step 3, not plan gaps. No TBD/TODO/"handle edge cases". ✓

**Type consistency:** `isRegistrationAllowed(publicKeyHex, allowlistEnv)` signature is identical in Tasks 1 and 2; env var name `HAPPY_ALLOWED_PUBLIC_KEYS` consistent across Tasks 1, 2, 5, 6; service name `happy-server`, secret `happy-secrets`, PVC `happy-data`, host `happy.digger.ooo` consistent across Tasks 4–6. ✓
