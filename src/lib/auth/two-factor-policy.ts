/**
 * The organisation two-factor policy, in one place.
 *
 * It used to live inside `withOrg()`, which meant any route that authenticated
 * some other way (`requireUser`, `getCurrentUser`) silently skipped it. The gate
 * now sits here and is called from BOTH doors:
 *
 *  - `withOrg()` (`src/lib/api/with-org.ts`), for the cookie-session path;
 *  - `requireUserForRoute()` (`src/lib/auth/cookies.ts`), for the handful of
 *    routes that resolve the session themselves.
 *
 * Exempt, on purpose:
 *  - API keys. They are machine credentials with their own scopes and
 *    revocation, and an agent cannot type a code.
 *  - The owner of an agent mailbox (`ownsAgentMailMailbox`): the two-factor
 *    routes refuse to enrol them at all, so the requirement would be a locked
 *    door with no key. Delegated access to a shared agent inbox does not count.
 *  - The small set of routes a blocked user must still reach to enrol.
 */
import { NextResponse } from "next/server";
import { getDb, type AppDatabase } from "@/db";
import { organizationRequiresTwoFactor } from "@/lib/auth/totp";
import { ownsAgentMailMailbox } from "@/lib/mailboxes/agent-mail";

/** The `error` code every gated response carries. */
export const TWO_FACTOR_REQUIRED = "two_factor_required";

/**
 * The exact paths a user must still reach while they are forced to enrol.
 *
 * An EXACT set, not a prefix: a prefix match on a raw pathname let
 * `/api/auth/two-factor/%2e%2e/%2e%2e/health` through, because the encoded dot
 * segments only became `..` after the runtime decoded them.
 */
const ENROLMENT_PATHS: ReadonlySet<string> = new Set([
	"/api/auth/two-factor",
	"/api/auth/two-factor/setup",
	"/api/auth/two-factor/enable",
	"/api/auth/two-factor/verify",
	"/api/auth/two-factor/disable",
	"/api/auth/two-factor/backup-codes",
	"/api/auth/me",
	"/api/auth/logout",
]);

/** Read-only: the policy itself cannot be changed from a blocked session. */
const ENROLMENT_PATHS_GET_ONLY: ReadonlySet<string> = new Set(["/api/settings/security"]);

/**
 * The request path in the one shape the allowlist is written in, or `null` when
 * it cannot be reduced to that shape — in which case it is never allowlisted.
 *
 * Everything ambiguous fails closed, which is why this returns `null` rather
 * than a best guess:
 *  - malformed percent-encoding (`decodeURIComponent` throws);
 *  - a `.` or `..` segment, before OR after decoding;
 *  - an empty segment (`//`), other than a single trailing slash;
 *  - a backslash or NUL.
 *
 * Matching is case-sensitive: the App Router is, so `/API/AUTH/ME` is not the
 * enrolment route and must not be treated as one.
 */
export function normaliseRequestPath(url: string): string | null {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\\") || decoded.includes("\0")) return null;

	const raw = decoded.split("/");
	// A pathname always starts with "/", so the first piece is always empty.
	if (raw[0] !== "") return null;
	const parts = raw.slice(1);
	// One trailing slash is tolerated ("/api/auth/me/"); nothing else empty is.
	if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
	for (const part of parts) {
		if (part === "" || part === "." || part === "..") return null;
	}
	return `/${parts.join("/")}`;
}

/** True when this request is one of the routes needed to enrol. */
export function isTwoFactorEnrolmentRoute(request: Request): boolean {
	const path = normaliseRequestPath(request.url);
	if (!path) return false;
	if (ENROLMENT_PATHS.has(path)) return true;
	return request.method === "GET" && ENROLMENT_PATHS_GET_ONLY.has(path);
}

/** The enrolment state of a cookie session. Null on the API-key path. */
export type TwoFactorSubject = { enrolled: boolean; userId: string };

/**
 * 403 when the organisation forces two-factor and this session's user has not
 * enrolled, `null` when the request may proceed.
 */
export async function twoFactorGate(
	db: AppDatabase,
	orgId: string,
	request: Request,
	session: TwoFactorSubject | null,
): Promise<NextResponse | null> {
	if (!session || session.enrolled) return null;
	if (isTwoFactorEnrolmentRoute(request)) return null;
	if (!(await organizationRequiresTwoFactor(db, orgId))) return null;
	if (await ownsAgentMailMailbox(db, session.userId, orgId)) return null;
	return NextResponse.json({ error: TWO_FACTOR_REQUIRED }, { status: 403 });
}

/**
 * The same gate, for a route that already has the user row in hand
 * (`requireUserForRoute`). `null` means allowed.
 */
export async function enforceTwoFactorPolicy(
	env: CloudflareEnv,
	user: { id: string; organizationId: string; totpEnabledAt: Date | null },
	request: Request,
): Promise<NextResponse | null> {
	return twoFactorGate(getDb(env), user.organizationId, request, {
		enrolled: !!user.totpEnabledAt,
		userId: user.id,
	});
}
