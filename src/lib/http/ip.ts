/**
 * Best-effort client IP resolution behind a reverse proxy (Coolify/Traefik/Nginx).
 * Prefers X-Forwarded-For (first entry, the original client), then X-Real-IP.
 */
export function getClientIp(request: Request): string {
	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) {
		const first = forwardedFor.split(",")[0]?.trim();
		if (first) return first;
	}

	const realIp = request.headers.get("x-real-ip")?.trim();
	if (realIp) return realIp;

	return "unknown";
}
