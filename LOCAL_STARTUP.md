# Local startup — self-hosted Convex

boop-agent runs its Convex backend **locally in Docker** instead of Convex
Cloud (to avoid the metered free-tier limits). Everything else — the Express
server, the debug dashboard, memory, automations, the Cloudflare tunnel — is
unchanged. This file is the runbook for booting the whole thing.

> **Just start it:** make sure Docker Desktop is installed, then run
> `npm run start:local`. That's the whole everyday flow. The rest of this file
> is context, first-time setup, and troubleshooting.

---

## What runs where

| Piece | Port | Started by |
|---|---|---|
| Convex backend (API + WebSocket) | 3210 | Docker (`docker compose`) |
| Convex HTTP-actions proxy (unused by this app) | 3211 | Docker |
| Convex dashboard (inspect tables/functions) | 6791 | Docker |
| Express server (the agent) | 3456 (`PORT`) | `dev.mjs` |
| Debug dashboard (the boop UI) | 5173 | `dev.mjs` (Vite) |
| Cloudflare tunnel → server | — | `dev.mjs` (`CLOUDFLARE_TUNNEL`) |

`npm run start:local` (`scripts/start-local.mjs`) brings up Docker + waits for
the backend + deploys functions, then hands off to `scripts/dev.mjs`, which
owns the server, Vite, the tunnel, webhook registration, and the ready banner.

The Convex data lives in a Docker **named volume** (`boop-convex_data`). It
survives reboots and `docker compose down`. It is only destroyed by
`docker compose down -v` — don't run that unless you mean to wipe everything.

---

## Prerequisites (one-time)

1. **Docker Desktop** installed and able to run. (`docker info` should succeed.)
2. **cloudflared** installed and the named tunnel already configured — it is;
   `dev.mjs` runs `cloudflared tunnel run <CLOUDFLARE_TUNNEL>` for you.
3. `.env.local` present with the self-hosted vars set (see migration below):
   - `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210`
   - `CONVEX_SELF_HOSTED_ADMIN_KEY=...`
   - `VITE_CONVEX_URL=http://127.0.0.1:3210`
   - `CONVEX_DEPLOYMENT` **unset/commented** (the CLI refuses to mix cloud +
     self-hosted config).

---

## Everyday startup

```bash
npm run start:local
```

**What success looks like:**
- `start-local │ Backend healthy (version …).`
- `start-local │ Deploying Convex functions …` → completes without error.
- The `dev.mjs` banner prints with your public URL, and:
  - Debug dashboard: <http://localhost:5173>
  - Convex dashboard: <http://localhost:6791> (log in with the admin key)
- Texting your Sendblue number gets a reply.

Stop everything with `Ctrl-C` (leaves the Docker backend running in the
background; that's intentional — it's cheap and keeps your data warm). To stop
the backend too: `docker compose down`.

---

## Auto-start on reboot (optional but recommended)

A launchd agent starts boop at login so it comes back after a reboot with no
manual step. `start:local` waits for Docker itself, so this is safe even before
Docker Desktop has finished launching.

```bash
mkdir -p .local-logs
sed "s|__REPO_DIR__|$(pwd)|g" scripts/com.boop-agent.local.plist \
  > ~/Library/LaunchAgents/com.boop-agent.local.plist
launchctl load ~/Library/LaunchAgents/com.boop-agent.local.plist
```

Manage it:
```bash
launchctl list | grep boop-agent                                   # loaded?
tail -f .local-logs/boop.err.log                                   # logs
launchctl unload ~/Library/LaunchAgents/com.boop-agent.local.plist # disable
```

---

## First-time migration (Convex Cloud → local) — one time only

This moves all your data (conversations, memories + embeddings, wiki chunks,
drafts, automations, images) from the cloud deployment into the local one.
`_id`, `_creationTime`, and file storage are preserved, so the agent keeps
every memory and the transition is invisible to you as a user.

The order matters: the Convex CLI **refuses to have `CONVEX_DEPLOYMENT` (cloud)
and `CONVEX_SELF_HOSTED_*` set at the same time**, so export first, then switch.

```bash
# 1. Export a full snapshot from Convex Cloud, INCLUDING file storage.
#    (Cloud vars still active in .env.local; self-hosted vars not set yet.)
npx convex export --include-file-storage --path ./convex-cloud-snapshot.zip

# 2. Stop writing to cloud: quit any running `npm run dev`, then re-run the
#    export so the snapshot captures the final state. (Snapshots are
#    point-in-time; the last one must be taken after writes stop.)

# 3. Bring up the empty local backend + generate an admin key.
docker compose up -d
docker compose exec backend ./generate_admin_key.sh   # copy the printed key

# 4. Switch .env.local to self-hosted:
#      - comment out CONVEX_DEPLOYMENT and the cloud VITE_CONVEX_URL
#      - add:
#          CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
#          CONVEX_SELF_HOSTED_ADMIN_KEY=<key from step 3>
#      (Never commit the admin key — .env.local is gitignored.)

# 5. Deploy schema + functions to the local backend (also rebuilds the two
#    1024-dim vector indexes and regenerates convex/_generated).
npx convex deploy --env-file .env.local

# 6. Import the snapshot (restores all tables + images; preserves _id /
#    _creationTime / _storage).
npx convex import --replace-all --yes ./convex-cloud-snapshot.zip

# 7. Point the app clients at the local backend.
#      set in .env.local:  VITE_CONVEX_URL=http://127.0.0.1:3210

# 8. Start everything.
npm run start:local
```

Keep the cloud deployment and `convex-cloud-snapshot.zip` around for ~1 week as
a rollback.

---

## Health checks

```bash
docker compose ps                 # backend should be healthy, dashboard up
curl -s localhost:3210/version    # prints a version string when healthy
docker compose logs -f backend    # follow backend logs
```

Row-count / data spot check: open the Convex dashboard at
<http://localhost:6791> and confirm `messages`, `memoryRecords`, `wikiChunks`,
`automations`, and `drafts` are populated.

---

## Troubleshooting

- **`start-local` says the self-hosted vars aren't set** → you haven't done the
  migration, or `.env.local` still points at cloud. See the migration section.
- **Docker isn't running** → `start:local` tries to launch Docker Desktop on
  macOS and waits up to 2 min. If it still fails, open Docker Desktop manually.
- **Port already in use** (3210 / 5173 / 3456 / 6791) → something else is bound.
  Find it (`lsof -i :3210`) and stop it, or override the Convex ports via
  `CONVEX_BACKEND_PORT` / `CONVEX_DASHBOARD_PORT` in `.env.local` (and set
  `CONVEX_SELF_HOSTED_URL`/`VITE_CONVEX_URL` to match).
- **`convex deploy` complains about a version mismatch** → pin the backend
  image to a tag near your `convex` npm version: set `CONVEX_BACKEND_TAG` in
  `.env.local` (see `docker-compose.yml`), then `docker compose pull backend`
  and `docker compose up -d`.
- **You edited a `convex/` function** → `start:local` skips the `convex dev`
  watcher. Re-deploy with `npx convex deploy --env-file .env.local`, or run
  `npx convex dev` in a spare terminal while iterating.
- **Backend won't go healthy** → `docker compose logs backend`. On Apple
  Silicon the image runs under emulation if no arm64 build exists (slower first
  boot, still works).

---

## Backups

Self-hosted Convex has no automatic backups. Take one anytime:

```bash
npx convex export --include-file-storage --path ./backup-$(date +%F).zip
```

(Do this before upgrading the backend image. To upgrade: `docker compose pull`
then `docker compose up -d` — export first in case you need to roll back.)

---

## Rollback to Convex Cloud

The cloud deployment is untouched by this migration. To go back:
1. In `.env.local`: un-comment `CONVEX_DEPLOYMENT` and the cloud
   `VITE_CONVEX_URL`; remove the `CONVEX_SELF_HOSTED_*` vars.
2. `npm run dev` (the normal cloud entry point).
