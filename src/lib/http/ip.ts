/**
 * Client IP resolution behind the trusted reverse proxy (Coolify/Traefik).
 *
 * Traefik sets X-Real-IP to the connecting peer and appends that peer to
 * X-Forwarded-For. Client-supplied entries sit at the front of that list, so
 * we never use the first entry: prefer X-Real-IP, then the LAST forwarded
 * entry, which is the one written by our own proxy.
 *
 * `CF-Connecting-IP` is checked FIRST, but only when `TRUST_CF_HEADERS=true`.
 * The app is moving behind the Cloudflare proxy, where that header is written
 * by Cloudflare and is the only honest client address. Without Cloudflare in
 * front, anyone can set it on a direct request, so trusting it by default would
 * hand every attacker a free rate-limit bypass. Hence: opt-in, and only turn it
 * on when the origin refuses traffic that did not come through Cloudflare.
 */
export function getClientIp(request: Request): string {
	if (process.env.TRUST_CF_HEADERS === "true") {
		const cfIp = request.headers.get("cf-connecting-ip")?.trim();
		if (cfIp) return cfIp;
	}

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
