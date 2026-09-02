# API and integrations

Mailflare exposes APIs for domain management and sending email. Authentication and mailbox permissions still apply to these routes.

## The v1 API

`/api/v1/**` is the public, agent-facing surface. It is specified in
[`docs/openapi.yaml`](./openapi.yaml) (OpenAPI 3.1) — that file is the reference
for every route, request body, response schema and error code; the tables below
are only a summary.

| Route | Scope | Purpose |
| --- | --- | --- |
| `GET /api/v1/mailboxes` | `messages:read` | Mailboxes the key can reach |
| `GET /api/v1/conversations` | `conversations:read` | List conversations, newest activity first |
| `GET /api/v1/conversations/[id]` | `conversations:read` | One conversation with its messages and notes |
| `POST /api/v1/conversations/[id]/reply` | `send` | Reply into the thread |
| `POST /api/v1/conversations/[id]/assign` | `conversations:write` | Assign or unassign |
| `GET /api/v1/conversations/[id]/notes` | `conversations:read` | Internal notes, oldest first |
| `POST /api/v1/conversations/[id]/notes` | `conversations:write` | Add an internal note |
| `GET /api/v1/messages` | `messages:read` | List messages |
| `PATCH /api/v1/messages/[id]` | `messages:write` | `read`, `starred`, `status`, `snoozedUntil` |
| `GET /api/v1/search?q=` | `messages:read` | Full-text search over messages |
| `GET /api/v1/contacts` | `contacts:read` | List contacts |
| `POST /api/v1/drafts` | `messages:write` | Store an unsent message |
| `POST /api/v1/send` | `send` | Send a message |

Four rules hold everywhere on this surface:

- **Errors** are always `{ "error": "...", "code": "..." }`. `code` is a stable
  tag (`not_found`, `forbidden`, `invalid_body`, `rate_limited`, ...); it is
  absent on the responses the authentication layer produces.
- **Tenancy.** A key acts only inside the organisation it was issued in, and
  only on the mailboxes its owner may open. Anything else answers 404, so a row
  that exists elsewhere cannot be told apart from one that does not exist.
- **Paging** is cursor-based: pass the `nextCursor` of a page back as `cursor`.
  `nextCursor: null` is the last page.
- **Rate limit**: 600 requests per minute per key. Over that the answer is
  `429 {"error":"Rate limit exceeded","code":"rate_limited"}` with a
  `Retry-After` header in seconds.

Reply is the one call worth spelling out: everything but the body is optional,
because the recipient, the subject and the message being answered are all
derived from the conversation.

```bash
curl -X POST https://mail.easyserver.net/api/v1/conversations/cnv_123/reply   -H "Authorization: Bearer ep_..."   -H "Content-Type: application/json"   -d '{"text":"A replacement is on its way."}'
```

The outbound message is stored in the same conversation with `In-Reply-To` and
`References` set from the message it answers.

### Search

`GET /api/v1/search?q=` runs Postgres full-text search over a generated
`tsvector` on `messages` (subject, both addresses and the text body, `simple`
dictionary, GIN index). `q` takes the usual web-search syntax — quoted phrases,
`or`, and `-` to exclude — and hits come back ranked, best first.

## Domain management

Adding or removing a domain from Mailflare also updates Cloudflare Email Routing and sending resources.

| Mailflare route | Purpose |
| --- | --- |
| `GET /api/domains` | List connected domains |
| `POST /api/domains` | Connect a domain and configure Cloudflare |
| `GET /api/domains/[id]` | Get a connected domain |
| `DELETE /api/domains/[id]` | Remove a domain and clean up its Cloudflare resources |
| `GET /api/domains/[id]/dns` | View its routing and sending DNS status |

The hostname must be the apex of a zone available to the configured Cloudflare credentials, or a subdomain of that zone. Creating a mailbox also creates the Cloudflare Email Routing rule that delivers its address to `CF_EMAIL_WORKER_NAME`.

## Sending email

Send email through `POST /api/v1/send`. Attachments are optional and use Base64-encoded content:

```json
{
  "from": "support@example.com",
  "to": "user@example.net",
  "subject": "Report",
  "text": "Attached.",
  "attachments": [
    {
      "filename": "report.pdf",
      "type": "application/pdf",
      "contentBase64": "<base64 data>"
    }
  ]
}
```

The dashboard composer accepts up to 10 attachments, with a 10 MB limit per file and a 20 MB combined limit. Attachment metadata is stored in D1 and file content is stored in R2. Downloads require access to the mailbox containing the message.

## API keys

`/api/v1/**` routes accept `Authorization: Bearer ep_...`. Keys are created and managed in the dashboard under **API Keys**, or through `/api/api-keys` with a cookie session.

| Route | Purpose |
| --- | --- |
| `GET /api/api-keys` | List your keys (`scopes`, `expiresAt`, `revokedAt`, `lastUsedAt`) |
| `POST /api/api-keys` | Create a key. The full key is returned once and never again |
| `DELETE /api/api-keys/[id]` | Revoke a key |

Session cookies are never accepted as bearer credentials, and a bearer key is never accepted for the dashboard routes.

### Scopes

A key must be created with at least one scope, and only these scopes exist. Anything else is a 400. The catalogue lives in `src/lib/api/scopes.ts`.

| Scope | Grants |
| --- | --- |
| `messages:read` | Read messages and their attachments |
| `messages:write` | Update messages (read, star, status, snooze) |
| `conversations:read` | Read conversations and notes |
| `conversations:write` | Reply, assign, and add notes to conversations |
| `contacts:read` | Read contacts |
| `send` | Send email |

Each `/api/v1` route names the one scope it needs: `GET /api/v1/messages` needs `messages:read`, `POST /api/v1/send` needs `send`. A key without it gets `403 {"error":"Insufficient scope"}`.

A key can only ever act inside the organisation it was issued in, whatever its owner's other memberships are.

### Expiry and revocation

`POST /api/api-keys` takes an optional `expiresInDays` between 1 and 365; leave it out for a key that never expires. The dashboard offers 30, 90, 365 days or never.

```json
{
  "name": "Support agent",
  "scopes": ["messages:read", "send"],
  "expiresInDays": 90
}
```

`DELETE /api/api-keys/[id]` revokes a key by setting `revoked_at`; the row is kept so the audit trail and last-used data survive. Only the key's owner, inside the key's organisation, can revoke it — anyone else gets a 404.

After that, the key gets a 401 with a specific reason:

| Condition | Response |
| --- | --- |
| Revoked | `401 {"error":"API key revoked"}` |
| Past `expiresAt` | `401 {"error":"API key expired"}` |
| Unknown or malformed | `401 {"error":"Unauthorized"}` |

Every accepted call records `last_used_at` and `last_used_ip` on the key.

### Hashing

Keys are high-entropy random strings, so they are stored as a plain SHA-256 hex digest (`hash_algo = 'sha256'`) rather than run through a password KDF on every API call.

Keys issued before this change were bcrypt-hashed. They keep working: their rows carry `hash_algo = 'bcrypt'` and are verified with bcrypt. Nothing is re-hashed and no key is invalidated. Only new keys are SHA-256, so the bcrypt path disappears on its own as old keys are revoked or expire.

## Real-time updates

Mailflare uses a Durable Object WebSocket hub to notify connected users after an inbound message is stored. Mailbox owners, the domain administrator, and delegated users receive events for mailboxes they can access.

The `REALTIME` binding and its migration are declared in `wrangler.jsonc`. When a WebSocket is temporarily unavailable, the app retries the connection and uses a slower refresh until it recovers.

## Webhooks

An agent subscribes to events by registering an endpoint. Create one with
`POST /api/webhooks`:

```json
{
  "url": "https://example.com/hooks/mailflare",
  "description": "Support bot",
  "events": ["message.inbound", "conversation.assigned"]
}
```

The response carries the signing `secret` **once**. Store it; it is never shown
again.

| Route | What it does |
|---|---|
| `GET /api/webhooks` | List your endpoints |
| `POST /api/webhooks` | Create one (returns the secret) |
| `GET /api/webhooks/{id}` | One endpoint |
| `PATCH /api/webhooks/{id}` | Change `url`, `events`, `description` or `enabled` |
| `DELETE /api/webhooks/{id}` | Remove it and its delivery history |
| `GET /api/webhooks/{id}/deliveries` | Last 50 attempts, newest first |
| `POST /api/webhooks/{id}/deliveries/{deliveryId}/retry` | Replay one delivery |

### Events

| Event | Fires when | `data` |
|---|---|---|
| `message.inbound` | A message is stored in a mailbox | `messageId`, `mailboxId`, `from`, `to`, `subject` |
| `message.outbound` | A message is sent | `messageId`, `mailboxId`, `to`, `subject` |
| `message.failed` | A send fails | `messageId`, `error` |
| `conversation.assigned` | A conversation is assigned or unassigned | `conversationId`, `assignedUserId`, `subject`, `status` |
| `conversation.note` | An internal note is added | `conversationId`, `noteId`, `body`, `authorId` |
| `quota.warning` | Usage crosses 80% of an organisation limit | `organizationId`, `kind`, `limit`, `current`, `usage`, `threshold` |

`quota.warning` fires on the crossing only: the first write that takes a counter
from below 80% to 80% or more. Later writes above the threshold stay quiet until
usage drops back under it.

Events never leave their organisation. An endpoint only ever receives events for
the organisation it was created in.

### Request format

```
POST /hooks/mailflare
Content-Type: application/json
X-Mailflare-Event: message.inbound
X-Mailflare-Delivery: whd_8Kx1...
X-Mailflare-Timestamp: 1772409600
X-Mailflare-Signature: sha256=6f1b...

{"type":"message.inbound","data":{ ... }}
```

`X-Mailflare-Delivery` is stable across retries, so deduplicate on it. The
legacy `X-Email-Platform-Event` and `X-Email-Platform-Signature` headers are
still sent for consumers written before this format.

### Verifying the signature

The signature is `sha256=` plus the hex HMAC-SHA256 of
`timestamp + "." + rawBody`, keyed with your endpoint secret. Verify against the
**raw** body, before any JSON parsing.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const timestamp = headers["x-mailflare-timestamp"];
  const signature = headers["x-mailflare-signature"];
  if (!timestamp || !signature) return false;

  // Reject replays of a captured request.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### Retries

An attempt is a failure when it times out (10s), the connection breaks, or the
response is not 2xx. Redirects are not followed.

| Failed attempts | Next attempt |
|---|---|
| 1 | in 1 minute |
| 2 | in 10 minutes |
| 3 | none — the delivery is dead-lettered |

A dead-lettered delivery has `status = "dead"`, is flagged in the admin UI, and
can be replayed by hand from the deliveries drawer or the retry route. Due
retries are sent by `scripts/webhook-retry.ts`, which is meant to run every
minute:

```
* * * * *  cd /app && npx tsx scripts/webhook-retry.ts
```

Deliveries for a disabled endpoint are held, not dropped: they resume when the
endpoint is enabled again.
