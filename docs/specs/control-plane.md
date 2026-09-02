# Mailflare control plane — build spec / task list

Status: **ready to execute**. Last updated 2026-09-02.
Stack assumed: the post-pivot stack in `CLAUDE.md` (Node + Supabase Postgres on supascale, Supabase Storage → R2, thin Cloudflare edge worker). Anything referring to D1/Workers is obsolete.

Goal: turn mailflare-gf into an email control system for our own use. One platform console for Gabe, isolated organisations (clients/teams) underneath, mail accounts issued to other people, quotas, and an API an agent can actually drive. Fix the live security holes first.

## How this list is meant to be run

- Each task is sized for **one Opus 5 subagent** working alone in the listed files. Tasks in the same wave that don't share files can run in parallel. Tasks in later waves depend on earlier waves (see "Depends on").
- Every task's definition of done: `npm run typecheck` = 0 errors, `npm run build` passes, new/changed DB tables ship as a Drizzle migration in `drizzle/migrations/` (`npm run db:generate`), and the acceptance checks in the task pass. Tests go in `tests/` (Wave 0 adds the runner).
- Subagent brief must include: this file's task section verbatim, `CLAUDE.md`, and the rule "only touch the files listed under *Scope*; report anything else you find instead of fixing it".
- After each wave: deploy (see `CLAUDE.md` → Deploy), run migrations through the tunnel, and do the smoke checks in `CLAUDE.md`.

## Decisions already made

| # | Decision | Why |
|---|---|---|
| D1 | **Shared database, `organization_id` column on every tenant-owned row.** Not one DB per tenant. | Simpler, one migration path, reversible later; the reverse is not. |
| D2 | **Platform operator is a separate table + separate route group, never a `role: superadmin`.** | A role flag is one bad `WHERE` from cross-tenant exposure; that bug already exists once (`listAccountsForAdmin`). |
| D3 | All tenant queries go through a `withOrg()` helper that hands the handler an org-scoped context. No hand-rolled org filters in routes. | 65 routes hand-roll auth today. Make cross-tenant leaks structurally impossible. |
| D4 | Conversations become a real table before the agent API is built. | Assignment, notes, collision detection and the agent API all need it. |
| D5 | Quotas are enforced with Postgres transactions + `SELECT ... FOR UPDATE` on the usage row. | We have real transactions now (Supavisor session pool on 56322). |
| D6 | Outbound stays on the Cloudflare edge worker. Transport is pluggable if that changes. | Already working; nothing stored on Cloudflare. |

---

## Wave 0 — Test harness (½ day)

### T0.1 Add vitest + DB test helpers
**Scope:** `package.json`, `vitest.config.ts`, `tests/setup.ts`, `tests/helpers/db.ts`, `.github/workflows/ci.yml` (new).
**Do:** Add `vitest` and `@vitest/coverage-v8` as devDependencies; `npm test` runs `vitest run`. `tests/helpers/db.ts` opens the DB from `TEST_DATABASE_URL` (default: the tunnel URL on `127.0.0.1:46322`, database `mailflare_test`), creates the schema by running the migrator against a **separate database** (`mailflare_test`) and truncates all tables between test files. Add a CI workflow that runs `npm run typecheck`, `npm run build`, and `npm test` (tests skipped in CI when `TEST_DATABASE_URL` is unset).
**Accept:** `npm test` passes with one smoke test that inserts and reads a `users` row. CI green on `main`.
**Depends on:** nothing.

---

## Wave 1 — Close the live security holes (2 days, all parallel)

### T1.1 Session token must not leave the cookie
**Scope:** `src/app/api/auth/login/route.ts`, `src/app/api/auth/register/route.ts`, `src/lib/auth/client.ts`, `src/lib/auth/session.ts`, `src/lib/api/auth.ts`, any component that reads the token from the login response.
**Problem:** login returns `token` in the JSON body (`login/route.ts:51`), the client stores it and sends `Authorization: Bearer` (`client.ts:41`), and the server accepts session tokens as bearers. The httpOnly cookie therefore protects nothing; any XSS reads the token.
**Do:** Stop returning the token in the body. Client uses the cookie only (`credentials: "include"`). `Authorization: Bearer` is accepted **only** for API keys (prefix check: API keys start with the `ep_` prefix (`KEY_PREFIX` in `src/lib/api-keys.ts`); session tokens are rejected there). Keep `getSessionTokenFromRequest` cookie-only.
**Accept:** Test: login response body has no `token`; a request with `Authorization: Bearer <session token>` to `/api/auth/me` is 401; cookie auth still works end to end in the browser.

### T1.2 IMAP import SSRF: block hosts that *resolve* to private space
**Scope:** `src/lib/import/imap-utils.ts`, `src/lib/import/imap.ts`, `tests/imap-host.test.ts`.
**Problem:** `assertSafeImapHost` only blocks literal private IPv4s. A hostname resolving to 10.x/127.x/169.254.x/172.16-31.x/192.168.x/::1/fc00::/fe80:: passes.
**Do:** Resolve with `dns.promises.lookup(host, { all: true })` before connecting; reject if any address is private/loopback/link-local (v4 and v6). Connect to the resolved address (pass `host` for TLS SNI) so DNS can't flip between check and connect.
**Accept:** Tests cover literal IPs, a hostname mocked to resolve private, and a public host.

### T1.3 Inbound idempotency and no silent loss
**Scope:** `src/app/api/edge/inbound/route.ts`, `src/lib/email/inbound.ts`, `src/db/schema/index.ts` (messages: unique index), migration, `tests/inbound.test.ts`.
**Problem:** the edge worker can retry; the same raw message can be stored twice. Failures after raw storage are only logged into `audit_logs` (`email.inbound_failed`), with no retry.
**Do:**
1. Unique partial index `messages(mailbox_id, provider_message_id) WHERE direction='inbound' AND provider_message_id IS NOT NULL`; on conflict, skip insert and return 200 (already delivered).
2. New table `inbound_failures(id, raw_r2_key UNIQUE, mailbox_id, from_addr, to_addr, error, attempts, next_attempt_at, created_at, resolved_at)`. On processing failure write a row (replace the audit-log-only path).
3. `POST /api/admin/inbound-failures/[id]/retry` (admin) re-runs `processInboundMessage` from the stored raw key; `GET /api/admin/inbound-failures` lists them. Minimal admin page under `(admin)/inbound-failures`.
**Accept:** Posting the same `.eml` twice yields one `messages` row. A forced parse failure produces an `inbound_failures` row and the retry endpoint clears it.

### T1.4 Scope the admin account list
**Scope:** `src/app/api/accounts/utils.ts`, `src/app/api/accounts/route.ts`, `tests/accounts.test.ts`.
**Problem:** `listAccountsForAdmin` lists every user instance-wide while every sibling route scopes to `createdByUserId`.
**Do:** Filter to accounts the caller created (`created_by_user_id = caller`) plus the caller. (Org scoping replaces this in Wave 3; this is the stop-gap.)
**Accept:** Test with two admins: each sees only their own tree.

### T1.5 Deleting a mailbox must clean up Cloudflare and storage
**Scope:** `src/app/api/mailboxes/[id]/route.ts`, `src/lib/mailboxes/*` (service for delete), `src/lib/email/attachments.ts` (bulk delete helper), `tests/mailbox-delete.test.ts`.
**Problem:** deleting a mailbox leaves its Email Routing rule(s) live (200-rule ceiling per domain) and orphans its messages' raw + attachment objects.
**Do:** Delete routing rules for every domain the mailbox was routed on (via `src/lib/cloudflare-api.ts`), delete attachment and raw objects from `BUCKET` for its messages, then delete rows. Do Cloudflare first; if it fails, abort with 502 and leave the DB untouched. Log a summary to `audit_logs`.
**Accept:** After delete: no rule for the address on the zone, no `stub/mail/inbound/*` or `attachments/*` objects for its messages remain, rows gone.

### T1.6 Content security: no inline/eval, server-side HTML sanitisation
**Scope:** `src/lib/security/headers.ts`, `src/lib/email/sanitize.ts` (new), `src/app/api/messages/**` (response shaping), `src/app/api/v1/messages/route.ts`, `src/lib/export/*`, `src/lib/email/webhooks.ts`, the message body component.
**Problem:** CSP allows `unsafe-inline` + `unsafe-eval`; inbound HTML is sanitised client-side only; API/export/webhooks emit raw HTML.
**Do:** Sanitise HTML once on the server (DOMPurify via `isomorphic-dompurify`, allowlist tags/attrs, strip scripts/forms/on*, force `rel="noopener"` + `target="_blank"`, neuter `javascript:`/`data:` URLs except images) and store the sanitised body in `messages.html_body`; keep raw in storage. Tighten CSP: drop `unsafe-eval`; use nonces for Next's inline scripts (`headers()` + `nonce` per request) if Next 16 needs it, otherwise drop `unsafe-inline` too. Render bodies in a sandboxed `<iframe sandbox>` with `srcdoc`.
**Accept:** A test message with `<script>` and `onerror=` lands with those stripped; CSP header has neither `unsafe-*` token; app UI still works (manual check).

---

## Wave 2 — Give mail a conversation (2 days)

### T2.1 Conversations table + threading headers
**Scope:** `src/db/schema/index.ts`, migration, `src/lib/email/parse.ts`, `src/lib/email/inbound.ts`, `src/lib/email/send.ts`, `src/lib/conversations/*` (new), `src/components/message-actions/utils.ts` (remove regex thread faking where replaced), `tests/conversations.test.ts`.
**Problem:** `thread_id` is set to each message's own Message-ID and read nowhere; `In-Reply-To`/`References` are discarded on parse and never emitted on send, so replies break threading in the recipient's client.
**Do:**
- `conversations(id, organization_id NULL for now, mailbox_id, subject_normalized, last_message_at, message_count, assigned_user_id NULL, status 'open'|'closed'|'snoozed', created_at)`; `messages.conversation_id` FK + index; `messages.in_reply_to`, `messages.references` (text[]).
- Parse `In-Reply-To`/`References`; resolve conversation between parse and insert: match on any referenced Message-ID in the same mailbox, else on normalised subject + participant within 7 days, else create.
- On send/reply: set `In-Reply-To` and `References` headers and attach the outbound to the conversation.
- Backfill migration groups existing messages by normalised subject + mailbox.
**Accept:** Sending a reply to an inbound message produces an outbound with correct `In-Reply-To`; both land in one conversation; Gmail threads the reply (manual check once).

### T2.2 Conversation API (internal)
**Scope:** `src/app/api/conversations/**` (new), `src/lib/conversations/*`, `src/lib/validators.ts`.
**Do:** `GET /api/conversations?mailboxId&status&assigned&q`, `GET /api/conversations/[id]` (messages inline), `POST /api/conversations/[id]/assign`, `POST /api/conversations/[id]/notes` (`conversation_notes` table), `PATCH /api/conversations/[id]` (status/snooze). Respect mailbox access levels from `src/lib/mailboxes/access.ts`.
**Accept:** Tests for each route incl. an access-denied case.
**Depends on:** T2.1.

---

## Wave 3 — Organisations and the platform console (5 days)

### T3.1 Organisations table and backfill
**Scope:** `src/db/schema/index.ts`, migration, `scripts/backfill-org.ts`.
**Do:** `organizations(id, name, slug UNIQUE, status 'active'|'suspended', notes, created_at)`. Add `organization_id NOT NULL` to `users`, `domains`, `mailboxes`, `messages` (denormalised on purpose: every hot query filters on it), `conversations`, `contacts`, `folders`, `api_keys`, `webhooks`, `routing_rules`, `email_templates`, `calendar_events`, `audit_logs`. Indexes on `(organization_id, ...)` for the hot lists (messages by mailbox, mailboxes by domain). Migration creates one org (`slug='default'`, name from `app_settings.app_name`) and points every existing row at it.
**Accept:** Migration runs on a copy of prod data (tunnel) with zero NULL `organization_id`.

### T3.2 `withOrg()` request scope + migrate every route
**Scope:** `src/lib/api/with-org.ts` (new), `src/lib/auth/session.ts` (session user carries `organizationId`), and **every** `src/app/api/**/route.ts` except `api/platform/**`, `api/edge/**`, `api/setup/**`, `api/auth/**`.
**Do:** `withOrg(handler)` authenticates (cookie or API key), loads the org, rejects suspended orgs (403), and passes `{ env, db, user, org }` where `db` is a Drizzle instance wrapped so **every** query on a tenant table gets `organization_id = org.id` appended (implement as a thin query-builder wrapper for `select/insert/update/delete` on the tenant table list, or, if that fights Drizzle too hard, a `scoped(table)` helper that returns `and(eq(table.organizationId, org.id), ...)` and a lint rule (`eslint` custom rule in `eslint.config.mjs`) that fails any query on a tenant table without it). Convert all routes; delete the per-route hand-rolled scoping they replace.
**Accept:** A test creates two orgs with one mailbox each; every list/get route called as org A never returns org B rows. Lint rule fails on an unscoped query.
**Depends on:** T3.1. This is the biggest single task; split by route folder across up to 4 subagents once `with-org.ts` exists (`accounts+mailboxes`, `messages+drafts+conversations`, `domains+routing-rules+folders+contacts`, `api-keys+webhooks+calendar+templates+settings`).

### T3.3 Platform operators and `/api/platform/*`
**Scope:** `src/db/schema/index.ts` (`platform_operators(user_id PK, created_at, created_by)`), migration, `src/lib/platform/guard.ts` (`requirePlatformOperator`), `src/app/api/platform/**` (new), `src/lib/platform/*`.
**Do:** Endpoints: `GET /api/platform/orgs` (counts: mailboxes, accounts, storage bytes, sends today), `POST /api/platform/orgs` (name, slug, quota template, first admin user → invite email via the app's own transport), `GET/PATCH /api/platform/orgs/[id]` (suspend/restore), `POST /api/platform/orgs/[id]/impersonate` (time-boxed 1h session flagged `impersonated_by`, written to `audit_logs` as `platform.impersonate`), `GET /api/platform/search?q=` (mailbox/domain across orgs). Seed: migration inserts the existing admin user into `platform_operators`.
**Accept:** Tests: a normal org admin gets 403 on every platform route; operator can create an org and impersonate; impersonation writes an audit row and expires.
**Depends on:** T3.1, T3.2.

### T3.4 Platform console UI
**Scope:** `src/app/(platform)/**` (new route group + layout), `src/components/platform/**`.
**Do:** Orgs list with live counts, create-org form, org detail (domains, mailboxes, members, usage vs quota, audit trail), suspend/restore, impersonate button, global search. Visible only to platform operators (server-side check in layout). Match the existing admin UI style (`src/app/(admin)`).
**Accept:** Manual walkthrough of every action against the deployed app.
**Depends on:** T3.3.

### T3.5 Org-scoped account management (issue accounts to people)
**Scope:** `src/app/api/accounts/**`, `src/lib/accounts/*` (new), `src/app/(admin)/accounts/**`, invite email template.
**Do:** Org admins create users in their org (email, name, role `admin|user`, `can_manage_mailboxes`), invite flow (single-use token, 7 days, set password page), per-user mailbox issuance (personal inbox on any org domain), ownership transfer (`POST /api/accounts/[id]/transfer` moves mailboxes/conversations to another org user before disable), disable/re-enable. Remove the old `created_by_user_id` tree logic where org scoping supersedes it.
**Accept:** Tests: invite → set password → login; transfer moves everything; disabled user can't log in and their sessions are revoked.
**Depends on:** T3.2.

---

## Wave 4 — Provisioning that can't half-fail (3 days)

### T4.1 Atomic domain provisioning with rollback
**Scope:** `src/lib/domains/provision.ts`, `src/lib/domains/service.ts`, `src/app/api/setup/domain/route.ts`, `src/app/api/auth/register/route.ts`, `src/app/api/domains/route.ts`.
**Problem:** first-run provisions the same domain twice (setup discards its result, register does it again); nothing rolls back Cloudflare state when a later step fails.
**Do:** One `provisionDomain()`: zone lookup → enable routing → (optional) sending subdomain → catch-all + rules → DB rows, with compensating deletes on any failure. Setup calls it once; register reuses the row. Idempotent on re-run.
**Accept:** Test with a mocked Cloudflare client where step 3 throws: no rules remain, no row written.

### T4.2 Domain status as a state machine
**Scope:** `src/db/schema/index.ts` (`domains.status` values + `last_checked_at`, `dns_ok`), migration, `src/lib/domains/status.ts` (new), `src/lib/dns-status.ts`, a reconcile endpoint `POST /api/domains/[id]/reconcile` and a scheduled call (`scripts/reconcile-domains.ts` run by supascale/cron on the box, or a Coolify scheduled task).
**Do:** `pending → active | error`, `error` actually assigned when DNS/routing checks fail; reconcile compares live Cloudflare state to the row and updates it; UI reads the row instead of recomputing DNS on every page load.
**Accept:** Breaking the MX record on a test zone flips status to `error` on reconcile and back on fix.

---

## Wave 5 — Quotas (3 days)

### T5.1 Quota tables and enforcement points
**Scope:** `src/db/schema/index.ts`, migration, `src/lib/quotas/*` (new), and the four chokepoints: `src/app/api/mailboxes/route.ts` (POST), `src/app/api/accounts/route.ts` (POST), `src/lib/email/send.ts`, `src/lib/email/inbound.ts` (before insert), plus `src/lib/email/attachments.ts` (attachment bytes).
**Do:** `org_quotas(organization_id PK, max_mailboxes, max_shared_mailboxes, max_accounts, max_domains, max_storage_bytes, max_daily_sends, max_attachment_bytes)` and `org_usage(organization_id PK, mailboxes, accounts, domains, storage_bytes, sends_today, day_key, updated_at)`. Enforce inside a transaction: `SELECT ... FOR UPDATE` on the usage row, check, increment, commit; 429/409 with a clear message on breach. `day_key` rolls sends_today. Quota templates: `small`, `standard`, `unlimited` in code.
**Accept:** Tests: creating one mailbox over the limit fails; 20 parallel creates against a limit of 10 end with exactly 10 rows.
**Depends on:** T3.1, T3.2.

### T5.2 Storage reclaim / retention
**Scope:** `src/lib/retention/*` (new), `scripts/retention.ts`, `src/app/api/messages/**` (trash → real delete after N days), `src/lib/backups/workflow.ts` (unchanged interface).
**Problem:** nothing is ever deleted: sessions, audit logs, webhook deliveries, auto-reply records, outbound jobs, trashed messages, raw objects, attachments.
**Do:** Per-org retention settings (defaults: trash 30d, sessions expired+7d, webhook deliveries 30d, audit logs 365d, auto-reply records 30d, outbound jobs 30d). Deleting a message removes its raw object and attachments and decrements `org_usage.storage_bytes`. `scripts/retention.ts` runs daily on the box.
**Accept:** Test: a trashed message older than the window is gone from DB and storage after the job; usage decremented.
**Depends on:** T5.1.

---

## Wave 6 — Agent API (6 days)

### T6.1 Fix the key model
**Scope:** `src/lib/api-keys.ts`, `src/lib/api/auth.ts`, `src/db/schema/index.ts` (`api_keys`: + `organization_id`, `expires_at`, `revoked_at`, `last_used_ip`), migration, `src/app/api/api-keys/**`, `src/app/(admin)/api-keys/page.tsx`.
**Problems:** keys can't be revoked (no DELETE), scopes are decorative (the create UI hardcodes every scope), bearer header is ambiguous (fixed in T1.1), bcrypt on every API call.
**Do:** SHA-256 hashing (keys are high-entropy), `DELETE /api/api-keys/[id]` (sets `revoked_at`), expiry, real scope selection in the UI, `requireScope` enforced per route (`messages:read`, `messages:write`, `conversations:read`, `conversations:write`, `contacts:read`, `send`). Migration re-hashes nothing (old keys are invalidated; document it).
**Accept:** Tests: revoked/expired key → 401; wrong scope → 403.

### T6.2 v1 API surface
**Scope:** `src/app/api/v1/**`, `docs/api.md`, OpenAPI file `docs/openapi.yaml`.
**Do:** `GET /v1/mailboxes`, `GET /v1/conversations`, `GET /v1/conversations/:id`, `POST /v1/conversations/:id/reply`, `POST /v1/conversations/:id/assign`, `POST /v1/conversations/:id/notes`, `PATCH /v1/messages/:id` (read/star/status/snooze), `GET /v1/contacts`, `POST /v1/drafts`, `GET /v1/search?q=` (Postgres FTS: `tsvector` column on messages, GIN index, migration). Consistent error shape, pagination by cursor, per-key rate limit (token bucket in `org_usage`-style row or in-memory per key with `Retry-After`).
**Accept:** OpenAPI validates; a scripted agent run (create draft → reply → assign → note → search) passes against the deployed app with a scoped key.
**Depends on:** T2.2, T3.2, T6.1.

### T6.3 Webhook events an agent can subscribe to
**Scope:** `src/lib/email/webhooks.ts`, `src/app/api/webhooks/**`, `src/db/schema/index.ts` (`webhooks.organization_id`, event catalogue), delivery retry with backoff (`webhook_deliveries.next_attempt_at`), `scripts/webhook-retry.ts`.
**Do:** Events: `message.inbound`, `message.outbound`, `conversation.assigned`, `conversation.note`, `quota.warning`. HMAC signature header, 3 retries with backoff, dead-letter after that (visible in UI).
**Accept:** Tests for signing and retry scheduling; manual delivery to a request bin.
**Depends on:** T2.1, T3.2.

---

## Parallelisation map

```
Wave 0:  T0.1
Wave 1:  T1.1 | T1.2 | T1.3 | T1.4 | T1.5 | T1.6          (6 agents, no shared files)
Wave 2:  T2.1  →  T2.2
Wave 3:  T3.1  →  T3.2 (split into 4 route-folder agents)  →  T3.3 → T3.4
                                                            ↘  T3.5
Wave 4:  T4.1 | T4.2                                        (after T3.2)
Wave 5:  T5.1  →  T5.2                                      (after T3.2)
Wave 6:  T6.1 | T6.3  →  T6.2                               (after T2.2, T3.2)
```

Rough total: ~22 working days of agent time; wall-clock far less with parallel waves.

## Out of scope for now

- Per-tenant databases (D1).
- Maillayer/SES transport.
- Billing/metering beyond quota counters.
- Mobile UI.
