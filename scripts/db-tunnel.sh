#!/usr/bin/env bash
# Open an SSH tunnel to the mailflare Supabase stack on the Vultr box.
# The stack is bound to the private bridge IP 10.0.8.1 and is NOT reachable
# from the internet; sshd on the box only permits forwards to these ports.
#
#   Studio   http://127.0.0.1:46321          (login: DASHBOARD_USERNAME / DASHBOARD_PASSWORD)
#   API      http://127.0.0.1:46321/rest/v1  (apikey header)
#   Postgres postgres://postgres.your-tenant-id:<pw>@127.0.0.1:46322/postgres
#   Pooler   postgres://postgres.your-tenant-id:<pw>@127.0.0.1:46329/postgres
#   MCP      http://127.0.0.1:46323/api/mcp   (Studio built-in MCP; registered as supabase-mailflare)
#
# Usage: scripts/db-tunnel.sh          (Ctrl-C to close)
set -euo pipefail
HOST="${SUPASCALE_SSH_HOST:-openship}"   # ~/.ssh/config alias for ops@45.63.13.90
exec ssh -N -o ExitOnForwardFailure=yes \
	-L 46321:10.0.8.1:56321 \
	-L 46322:10.0.8.1:56322 \
	-L 46329:10.0.8.1:56329 \
	-L 46323:10.0.8.1:56323 \
	"$HOST"
