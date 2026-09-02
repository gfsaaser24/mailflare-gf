/**
 * Client IP resolution behind the trusted reverse proxy (Coolify/Traefik).
 *
 * Traefik sets X-Real-IP to the connecting peer and appends that peer to
 * X-Forwarded-For. Client-supplied entries sit at the front of that list, so
 * we never use the first entry: prefer X-Real-IP, then the LAST forwarded
 * entry, which is the one written by our own proxy.
 */
export function getClientIp(request: Request): string {
	const realIp = request.headers.get("x-real-ip")?.trim();
	if (realIp) return realIp;

	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) {
		const entries = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
		const last = entries[entries.length - 1];
		if (last) return last;
	}

	return "unknown";
}
