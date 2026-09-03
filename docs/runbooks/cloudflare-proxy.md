# Runbook — put `mail.easyserver.net` behind the Cloudflare proxy

Today the record is grey-cloud (DNS only): browsers connect straight to the Vultr box
and Traefik terminates TLS. This runbook turns the orange cloud on so Cloudflare sits in
front, then makes the origin trust the headers Cloudflare adds — and only those.

**Do the steps in order.** Step 4 (`TRUST_CF_HEADERS=true`) must be last. Turning it on
while the record is still grey lets anybody set `CF-Connecting-IP` on a direct request
and spoof their client IP past every rate limit.

Inbound mail is unaffected: Cloudflare Email Routing calls the `mailflare-edge` worker,
which calls `POST https://mail.easyserver.net/api/edge/inbound` over the same public
hostname. It is a normal HTTPS request, so it keeps working proxied. Outbound
(`POST <EDGE_WORKER_URL>/send`) never touches this hostname at all.

---

## 0. Before you start

- Cloudflare dashboard access to the `easyserver.net` zone.
- `ssh openship` (passwordless sudo) for the Traefik config.
- Coolify access for the app environment (app uuid `btq8s4mmxwf7mvbsvxbaui8n`).
- A second browser/terminal to test with, so a mistake does not lock you out.

Record the current state so you can roll back:

```sh
curl -sI https://mail.easyserver.net | head -20
dig +short mail.easyserver.net
```

---

## 1. TLS mode: Full (strict)

In the Cloudflare dashboard, zone `easyserver.net` → **SSL/TLS** → **Overview**, set the
encryption mode to **Full (strict)**.

- *Flexible* is not acceptable: Cloudflare would talk plain HTTP to the origin.
- *Full* (not strict) accepts a self-signed origin certificate, so a man in the middle
  between Cloudflare and Vultr goes unnoticed.
- *Full (strict)* requires a certificate the origin presents that Cloudflare can verify.

Two ways to satisfy it. Pick one.

**A. Keep Let's Encrypt on Traefik (recommended, no change needed).**
Traefik already holds a real Let's Encrypt certificate, which Cloudflare verifies fine.
HTTP-01 renewals keep working behind the proxy because Cloudflare proxies port 80 and
forwards `/.well-known/acme-challenge/*` to the origin. Do **not** enable "Always Use
HTTPS" until you have seen one renewal succeed; if you do enable it, Cloudflare answers
the challenge with a 301 and the renewal fails. If that happens, switch Traefik to a
DNS-01 challenge (Cloudflare API token with `Zone:DNS:Edit`) — it is immune to anything
happening on port 80.

**B. Cloudflare Origin CA certificate.**
SSL/TLS → **Origin Server** → **Create Certificate**, hostnames `mail.easyserver.net`
(and `*.easyserver.net` if wanted), 15-year validity. Install the cert and key on the box
and point the Traefik file provider at them instead of the ACME resolver. This removes
renewal from the picture entirely, but the certificate is only trusted by Cloudflare — if
you ever go grey-cloud again, browsers will reject the origin. Note that in your rollback
plan.

---

## 2. Traefik: trust only Cloudflare's IPs for forwarded headers

Once proxied, every request reaches Traefik from a Cloudflare IP, and the real client
address arrives in `CF-Connecting-IP` / `X-Forwarded-For`. Traefik must accept those
headers **only** from Cloudflare, otherwise a direct request to the box can forge them.

Cloudflare publishes its ranges at <https://www.cloudflare.com/ips/> — machine-readable
at <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6>. The list
changes; re-check it when you touch this file.

Coolify runs Traefik as a container with its config under `/data/coolify/proxy/`. Add the
trusted IPs to the entrypoints:

```sh
ssh openship
sudo -e /data/coolify/proxy/dynamic/traefik.conf   # or the static traefik.yaml Coolify generates
```

```yaml
entryPoints:
  http:
    address: ":80"
    forwardedHeaders:
      trustedIPs: &cfips
        - 173.245.48.0/20
        - 103.21.244.0/22
        - 103.22.200.0/22
        - 103.31.4.0/22
        - 141.101.64.0/18
        - 108.162.192.0/18
        - 190.93.240.0/20
        - 188.114.96.0/20
        - 197.234.240.0/22
        - 198.41.128.0/17
        - 162.158.0.0/15
        - 104.16.0.0/13
        - 104.24.0.0/14
        - 172.64.0.0/13
        - 131.0.72.0/22
        - 2400:cb00::/32
        - 2606:4700::/32
        - 2803:f800::/32
        - 2405:b500::/32
        - 2405:8100::/32
        - 2a06:98c0::/29
        - 2c0f:f248::/32
  https:
    address: ":443"
    forwardedHeaders:
      trustedIPs: *cfips
```

Restart the proxy from the Coolify UI (Servers → Proxy → Restart), or:

```sh
sudo docker restart coolify-proxy
```

Optional but recommended: also drop non-Cloudflare traffic on 80/443 at the firewall, so
the origin cannot be reached directly at all. Only do this once step 5 confirms the
proxied path works, and keep an SSH session open while you do it.

---

## 3. Flip the record to orange cloud

Cloudflare dashboard → **DNS** → the `mail` record for `easyserver.net` → set **Proxy
status** to **Proxied**. Propagation is seconds.

Confirm right away:

```sh
curl -sI https://mail.easyserver.net | grep -i cf-ray
```

A `cf-ray:` header means the request went through Cloudflare. No header means you are
still hitting the origin directly — stop and fix that before step 4.

---

## 4. Only now: `TRUST_CF_HEADERS=true`

In Coolify → application `Mailflare` → **Environment Variables**, add:

```
TRUST_CF_HEADERS=true
```

Redeploy (env vars are baked into the container environment, not the image):

```sh
ssh openship
curl -H "Authorization: Bearer <T3C token>" -X POST http://10.0.0.1:8000/api/v1/deploy \
  -d '{"uuid":"btq8s4mmxwf7mvbsvxbaui8n","force":true}'
```

`src/lib/http/ip.ts` now prefers `CF-Connecting-IP`. That is the address the auth rate
limits count against, the address written to `sessions.ip_address`, and the address in
the audit trail.

---

## 5. WAF rate limit on `/api/auth/*` (defence in depth)

The app already rate-limits login, recovery, magic links and TOTP in process. A
Cloudflare rule stops the flood before it costs the origin anything.

Security → **WAF** → **Rate limiting rules** → **Create rule**:

- Name: `auth-burst`
- If incoming requests match: `(http.host eq "mail.easyserver.net" and starts_with(http.request.uri.path, "/api/auth/"))`
- Characteristics: **IP**
- Period: **1 minute**, Requests: **30**
- Then: **Block**, duration **10 minutes**
- Response: default (429)

Keep it looser than the in-app limits (login is 20/min per IP) so the app's own answers,
which are the ones users can act on, are what they normally see.

---

## 6. Confirm

```sh
# 1. Requests are proxied.
curl -sI https://mail.easyserver.net | grep -i cf-ray

# 2. Health endpoint answers through the proxy.
curl -s https://mail.easyserver.net/api/health          # -> {"ok":true}

# 3. Inbound relay path still reachable (401/404 is fine; a timeout is not).
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mail.easyserver.net/api/edge/inbound
```

Then, in a browser, sign out and sign in again. Open **Settings → Account → Sessions**:
the new row must show **your real public IP** (`curl -s https://ifconfig.me` from the same
machine), not a Cloudflare or Docker-bridge address. If it shows a Cloudflare IP,
`TRUST_CF_HEADERS` did not take effect; if it shows `10.0.x.x`, Traefik is not forwarding
the header.

Send one test email in and out and confirm a `messages` row plus an object under
`stub/mail/inbound/` in the R2 bucket.

---

## Rollback

1. Coolify: remove `TRUST_CF_HEADERS` (or set it to `false`), redeploy. **Do this first.**
2. Cloudflare DNS: set the `mail` record back to **DNS only** (grey cloud).
3. If you chose option B in step 1, put the Let's Encrypt resolver back in Traefik before
   going grey — the Origin CA certificate is not trusted by browsers.
4. The Traefik `trustedIPs` block is harmless when unproxied; leave it.
