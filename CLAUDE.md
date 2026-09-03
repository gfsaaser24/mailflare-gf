# mailflare-gf

Self-hosted email control plane (Next.js 16 + Drizzle). Forked from mailflare; all
tier/licence gating has been removed and must never come back. Do not mention licensing.

## Architecture (decided 2026-09-02)

Cloudflare is used as little as possible. No D1, no R2 bindings, no Workers app, no
Queues, no Durable Objects. Never reintroduce them.

| Piece | Where | Notes |
|---|---|---|
| App | Docker (Next standalone) on **Vultr Coolify**, https://mail.easyserver.net | project "Mailflare", app uuid `btq8s4mmxwf7mvbsvxbaui8n`, tracks `main` |
| Database | Supabase Postgres on **supascale** (Vultr `45.63.13.90`), project id `mailflare` | Supavisor: DB user is `postgres.your-tenant-id`; 56322 = session pool, 56329 = transaction pool |
| Object storage | Supabase Storage on that project, bucket `mail`, via its S3 gateway `/storage/v1/s3` | supascale backs Storage with Cloudflare R2 bucket `mailflare-storage` (compose overlay `docker-compose.r2.yml`) |
| Inbound mail | Cloudflare Email Routing → thin worker **`mailflare-edge`** (`cloudflare-worker/`) → `POST /api/edge/inbound` | worker stores nothing; 404 from the app = reject, other error = temp reject |
| Outbound mail | app → `POST <EDGE_WORKER_URL>/send` → Cloudflare `send_email` binding | transport is pluggable (`src/lib/email/transport.ts`); Maillayer/SES not used |
| Realtime | in-process emitter + SSE at `/api/realtime` | single app container; no DO |
| Backups | run inline in the app process; supascale handles DB backups/scheduling | |

`src/lib/env.ts` builds `AppEnv` (alias `CloudflareEnv`) from `process.env`; keep that
surface, don't spread `process.env` reads around. `BUCKET` is an R2Bucket-like adapter
(`src/lib/storage/bucket.ts`); `EMAIL` is an `EmailSender`.

## Network / security posture

- The whole Supabase stack is bound to the docker bridge IP **10.0.8.1 only**
  (`docker-compose.bindlocal.yml`), plus a DOCKER-USER DROP rule
  (`mailflare-docker-firewall.service`). Nothing on 5632x is reachable from the internet.
  The Coolify app container reaches `10.0.8.1:56321/56322` over the bridge.
- Postgres: RLS is ON for every public table and `anon`/`authenticated` have **no grants**
  (`.secrets/harden-db.cjs`). The app connects as `postgres` (owner) so it is unaffected.
  Supabase Auth signups are disabled; the app has its own sessions.
- storage-api verifies S3 SigV4 against `STORAGE_PUBLIC_URL` (= `http://10.0.8.1:56321`), and
  Kong has `KONG_PORT_MAPS=56321:8000,56764:8443`. If you change the public URL, recreate the
  `storage` container. S3 uploads only verify when addressed as `10.0.8.1:56321`.
- sshd on the box only permits forwards to listed targets
  (`/etc/ssh/sshd_config.d/99-infrastructure-hardening.conf`); `10.0.8.1:56321/56322/56323/56329` are allowed.

## Getting at the database / Studio / MCP from a laptop

```
scripts/db-tunnel.sh          # keep running; Ctrl-C closes it
```

| Local | Target | Use |
|---|---|---|
| http://127.0.0.1:46321 | Kong (API + Studio) | Studio login: user `supabase`, password `DASHBOARD_PASSWORD` in `.secrets/supabase.env` |
| 127.0.0.1:46322 | Postgres (session pool) | `postgres://postgres.your-tenant-id:<POSTGRES_PASSWORD>@127.0.0.1:46322/postgres` |
| 127.0.0.1:46329 | Postgres (transaction pool) | |
| http://127.0.0.1:46323/api/mcp | Studio's built-in MCP | registered in `.mcp.json` as `supabase-mailflare`; only works while the tunnel is up |

The hosted `supabase` MCP (mcp.supabase.com) cannot see self-hosted projects. The
`supascale-mcp` only does start/stop/backups; storage/network settings are changed on
disk over SSH (`ssh openship`, passwordless sudo) under `/opt/supascale-projects/mailflare/supabase/docker/`.

## Secrets

Everything sensitive lives in `.secrets/` (gitignored): `servers.md` (hosts, SSH, Coolify,
how-tos), `ssh/` (keys), `supabase.env`, `r2.env`, `edge.env`. `.env.local` is gitignored
too. Never commit any of it; the repo is public.

## Deploy

- **App**: push to `main`, then trigger Coolify. Its API is behind Cloudflare Access, so
  call it from the box: `ssh openship`, then
  `curl -H "Authorization: Bearer <T3C token>" -X POST http://10.0.0.1:8000/api/v1/deploy -d '{"uuid":"btq8s4mmxwf7mvbsvxbaui8n","force":true}'`
  (token: `claude mcp get vultr-coolify`). Env vars are managed in Coolify, not in the image.
- **Edge worker**: `npm run edge:deploy` with `CLOUDFLARE_API_KEY`/`CLOUDFLARE_EMAIL`/`CLOUDFLARE_ACCOUNT_ID`
  from `.secrets/r2.env`. Secret: `npx wrangler secret put EDGE_WORKER_SECRET --cwd cloudflare-worker`.
  Email Routing rules on each domain must target worker `mailflare-edge`.
- **Migrations**: `npm run db:generate` after schema edits (Postgres dialect), commit
  `drizzle/migrations/*`, then `DATABASE_URL=... npm run db:migrate` through the tunnel.
  The setup flow also runs pending migrations on first boot.

## Checks before you say done

`npm run typecheck` must be clean (0 errors). `npm run build` must pass. For anything that
touches inbound/outbound mail, hit `/api/edge/inbound` on the deployed app and confirm a
`messages` row plus an object under `stub/mail/inbound/` in the R2 bucket.

## Roadmap

Design record: `docs/specs/control-plane.md` (all waves shipped). Next candidates: platform-plane audit
endpoint, per-org DB export, Maillayer transport if Cloudflare sending ever limits us.

## Scheduled jobs

The image ships only the built app, so `scripts/*.ts` are for local/dev use. In production
the host cron (user `ops` on the Vultr box, `crontab -l`) calls
`POST https://mail.easyserver.net/api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`
(secret in `.secrets/cron.env`, `~/mailflare/cron.env` on the box, and the Coolify env):

| Job | Schedule | Does |
|---|---|---|
| `webhook-retry` | every minute | re-sends due webhook deliveries (1m/10m backoff, dead-letter after 3) |
| `retention` | 03:30 daily | per-org retention: trash purge (reclaims storage), sessions, deliveries, audit, jobs |
| `reconcile-domains` | hourly | refreshes `domains.status` from live Cloudflare/DNS state |

Log: `~/mailflare/cron.log` on the box.

## Control plane status (2026-09-02)

`docs/specs/control-plane.md` is fully implemented (waves 0–6): security fixes, conversations,
organisations + `withOrg()`, platform console, provisioning/status, quotas, retention, invites,
v1 agent API (`docs/openapi.yaml`), webhooks. 203 tests (`npm test`, needs the tunnel).
