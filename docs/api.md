# API and integrations

Mailflare exposes APIs for domain management and sending email. Authentication and mailbox permissions still apply to these routes.

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
