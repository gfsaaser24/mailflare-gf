/**
 * Shared plumbing for the public `/api/v1/**` surface (T6.2).
 *
 * Every v1 route is declared with `v1Route(handler, { requiredScope })`, which
 * is `withOrg({ allowApiKey: true, requiredScope })` plus the per-key rate
 * limit. Errors always come back as `{ error, code? }`.
 */
import { NextResponse } from "next/server";
import type { ScopeName } from "@/lib/api/scopes";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { withOrg, type OrgContext, type RouteContext } from "@/lib/api/with-org";
import { createMemoryRateLimit } from "@/lib/auth/memory-rate-limit";

/** Requests one API key may make per minute across the whole v1 surface. */
export const V1_RATE_LIMIT = 600;
export const V1_RATE_LIMIT_PERIOD_SECONDS = 60;

function createLimiter() {
	return createMemoryRateLimit({
		limit: V1_RATE_LIMIT,
		periodSeconds: V1_RATE_LIMIT_PERIOD_SECONDS,
	});
}

// In-process, like the login limiter: one app container, so a Map is enough.
let limiter = createLimiter();

/** Test hook: forgets every counter. Never called by the app. */
export function resetV1RateLimit(): void {
	limiter = createLimiter();
}

/** The one error shape the v1 API returns. `code` is a stable machine-readable tag. */
export function v1Error(error: string, status: number, code?: string): NextResponse {
	return NextResponse.json(code ? { error, code } : { error }, { status });
}

export type V1Options = { requiredScope: ScopeName };

export function v1Route<T extends RouteContext = RouteContext>(
	handler: (ctx: OrgContext, request: Request, routeCtx: T) => Promise<Response>,
	options: V1Options,
) {
	return withOrg<T>(
		async (ctx, request, routeCtx) => {
			// Cookie sessions are the dashboard and are limited elsewhere; the quota
			// here belongs to the key, not to its owner.
			if (ctx.user.kind === "api_key" && ctx.user.apiKeyId) {
				const { success } = await limiter.limit({ key: ctx.user.apiKeyId });
				if (!success) {
					return NextResponse.json(
						{ error: "Rate limit exceeded", code: "rate_limited" },
						{
							status: 429,
							headers: { "Retry-After": String(V1_RATE_LIMIT_PERIOD_SECONDS) },
						},
					);
				}
			}
			return handler(ctx, request, routeCtx);
		},
		{ allowApiKey: true, requiredScope: options.requiredScope },
	);
}

/** `{ params }` for a v1 route with an `[id]` segment. */
export type IdRouteContext = { params: Promise<{ id: string }> };

/** Reads and parses a JSON body, or returns the error response to send. */
export async function readV1Json(
	request: Request,
	maxBytes: number,
): Promise<{ body: unknown } | { response: NextResponse }> {
	try {
		return { body: await readJsonBody<unknown>(request, maxBytes) };
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) {
			return { response: v1Error("Request body too large", 413, "payload_too_large") };
		}
		return { response: v1Error("Invalid request body", 400, "invalid_body") };
	}
}
