# Deployment and configuration

This guide covers the Docker deployment of the app, the thin Cloudflare edge worker, runtime configuration, database backups, and application updates.

## Architecture

Mailflare runs as a normal Node application. Cloudflare keeps exactly two jobs, both handled by the thin worker in `cloudflare-worker/`:

- Email Routing delivers inbound mail to the worker's `email()` handler, which relays the raw message to `POST ${APP_URL}/api/edge/inbound`.
- The worker exposes `POST /send`, which relays outbound mail through the Cloudflare `send_email` binding.

The worker stores nothing. All data lives in Postgres (Supabase) and the S3-compatible object store.

## Deploy the app (Docker / Coolify)

The app is a standard Next.js server image. In Coolify, create an application from this repository, use the included Dockerfile, and set the environment variables listed in `.env.example`:

```bash
cp .env.example .env
```

Required values:

- `DATABASE_URL` — Supabase Postgres connection string.
- `STORAGE_S3_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` — the S3-style object store for raw messages and attachments.
- `APP_URL` — the public URL of this app. The edge worker posts inbound mail to it.
- `EDGE_WORKER_SECRET` — shared secret between the app and the edge worker. Generate one with `openssl rand -hex 32`.
- `EDGE_WORKER_URL` — the deployed edge worker URL, for example `https://mailflare-edge.<account>.workers.dev`.
- `CF_TOKEN` — a scoped Cloudflare API token with Zone Read, Email Routing Edit, and Email Routing Rules Write access for the domains you connect. You can use a legacy Global API Key instead by setting both `CF_API_KEY` and `CF_EMAIL`. Paste only the token value; do not include `Bearer` and do not use the token ID.
- `CF_EMAIL_WORKER_NAME` — the deployed edge worker name. Defaults to `mailflare-edge`.
- `CF_AID` — the Cloudflare account ID.

Apply database migrations against the configured Postgres database:

```bash
npm run db:migrate
```

## Deploy the edge worker

The worker lives in `cloudflare-worker/` and has its own `wrangler.jsonc`. Set `vars.APP_URL` there to the public URL of the app, then:

```bash
npm --prefix cloudflare-worker install
npx wrangler secret put EDGE_WORKER_SECRET --cwd cloudflare-worker
npm run edge:deploy
```

`EDGE_WORKER_SECRET` must be the same value as in the app environment. Check the deployment with `curl https://mailflare-edge.<account>.workers.dev/health`, which returns `ok`.

## Email Routing

For every connected domain, the Cloudflare Email Routing rule must target the Worker named `mailflare-edge` (or whatever you set as the worker `name` and `CF_EMAIL_WORKER_NAME`). Mailflare creates these rules for you when you add a domain; the names must match exactly or rule creation fails.

If you rename the worker, keep these values aligned:

- `name` in `cloudflare-worker/wrangler.jsonc`
- `CF_EMAIL_WORKER_NAME` in the app environment
- `EDGE_WORKER_URL` in the app environment

## First-run setup

Open `/setup` after deployment. Mailflare checks the required runtime configuration and initializes an empty database. It never applies later migrations to an existing database from the setup page.

## Database backups

Manual and scheduled backups use the `DATABASE_BACKUP_WORKFLOW` binding declared in `wrangler.jsonc`. Deploy the complete Worker with `npm run deploy` whenever this binding is added or changed.

Backups require:

- `CF_AID`
- `D1_DATABASE_ID`
- `D1_BACKUP_TOKEN`, or a `CF_TOKEN` that is also allowed to export the D1 database

## Updating Mailflare

The **Update Mailflare** button in the admin dashboard dispatches `.github/workflows/update.yml` in the installation repository. The workflow merges the latest upstream source, applies pending D1 migrations, and pushes the updated source. A connected Cloudflare Git integration can then build and deploy the change.

Configure these Worker values:

- `GITHUB_UPDATE_TOKEN` — a fine-grained GitHub token for the installation repository with Actions write permission.
- `GITHUB_UPDATE_REPO` — the installation repository in `owner/repository` format.
- `GITHUB_UPDATE_REF` — an optional update branch. The repository's default branch is used when omitted.

Configure these GitHub Actions repository secrets:

- `CLOUDFLARE_API_TOKEN` — a Cloudflare token allowed to read and migrate D1.
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID.
- `MAILFLARE_UPSTREAM_TOKEN` — required only when the upstream repository is private.

Optional repository variables:

- `MAILFLARE_UPSTREAM_REPOSITORY` — the upstream repository. Defaults to `hieunc229/mailflare`.
- `MAILFLARE_UPSTREAM_BRANCH` — the upstream branch. Defaults to `main`.

If an older installation contains a failing updater, copy the latest `.github/workflows/update.yml` into that installation once. An updater that cannot read upstream cannot update its own workflow.

