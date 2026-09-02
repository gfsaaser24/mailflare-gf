import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy } from "@/lib/security/headers";

/**
 * Generates a per-request CSP nonce and attaches the policy to both the
 * request and the response.
 *
 * Next reads the nonce out of the *request* `Content-Security-Policy` header
 * and stamps it onto the inline scripts it injects, which is what lets us drop
 * `'unsafe-inline'` from `script-src`. See
 * https://nextjs.org/docs/app/guides/content-security-policy
 */
export function proxy(request: NextRequest) {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const nonce = btoa(String.fromCharCode(...bytes));
	const csp = buildContentSecurityPolicy(nonce);

	const requestHeaders = new Headers(request.headers);
	requestHeaders.set("x-nonce", nonce);
	requestHeaders.set("Content-Security-Policy", csp);

	const response = NextResponse.next({ request: { headers: requestHeaders } });
	response.headers.set("Content-Security-Policy", csp);
	return response;
}

export const config = {
	matcher: [
		{
			// Everything except immutable build output and static assets, which
			// are not documents and never execute inline script.
			source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|otf|map)$).*)",
			missing: [
				{ type: "header", key: "next-router-prefetch" },
				{ type: "header", key: "purpose", value: "prefetch" },
			],
		},
	],
};
