/**
 * Content-Security-Policy is built per request so Next's own inline bootstrap
 * scripts (`self.__next_f.push(...)`) can carry a nonce instead of forcing
 * `'unsafe-inline'`. `src/proxy.ts` generates the nonce, puts this policy
 * on the request (Next reads the nonce back out of it) and on the response.
 * This only works because no HTML page is prerendered — see the
 * `force-dynamic` note in `src/app/layout.tsx`.
 *
 * `'unsafe-eval'` is never emitted in production; the dev server needs it for
 * React Fast Refresh only.
 */
export function buildContentSecurityPolicy(nonce?: string): string {
	const isDev = process.env.NODE_ENV !== "production";
	const scriptSrc = [
		"script-src 'self'",
		nonce ? `'nonce-${nonce}'` : null,
		// With 'strict-dynamic' the host allowlist below is ignored by CSP3
		// browsers; it stays as the CSP2 fallback and for the Turnstile widget.
		nonce ? "'strict-dynamic'" : "'unsafe-inline'",
		"https://challenges.cloudflare.com",
		isDev ? "'unsafe-eval'" : null,
	]
		.filter(Boolean)
		.join(" ");

	return [
		"default-src 'self'",
		scriptSrc,
		// Tailwind and React inline style props need this; there is no script
		// execution surface in style-src.
		"style-src 'self' 'unsafe-inline'",
		// `cid:` keeps inline email images working; the message body renderer
		// rewrites them to /api/messages/... before display.
		"img-src 'self' data: blob: https: cid:",
		"font-src 'self' data:",
		"connect-src 'self' ws: wss: https://challenges.cloudflare.com",
		// 'self' covers the sandboxed srcdoc iframe used to render email bodies.
		"frame-src 'self' blob: https://challenges.cloudflare.com",
		"child-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'self'",
		"upgrade-insecure-requests",
	].join("; ");
}

/**
 * Static headers applied from `next.config.ts`. CSP is deliberately absent:
 * emitting it here as well would leave two Content-Security-Policy headers on
 * every document response, and the browser enforces the intersection — which
 * would reject the nonce'd scripts. src/proxy.ts owns CSP.
 */
export function getSecurityHeaders() {
	return [
		{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
		{ key: "X-Content-Type-Options", value: "nosniff" },
		{ key: "X-Frame-Options", value: "SAMEORIGIN" },
		{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
		{
			key: "Permissions-Policy",
			value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		},
	];
}
