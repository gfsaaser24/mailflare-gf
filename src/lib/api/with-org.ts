/**
 * `withOrg()` — the one way an API route gets a tenant-scoped request context.
 *
 * ---------------------------------------------------------------------------
 * HOW TO USE IT (copy this)
 * ---------------------------------------------------------------------------
 *
 *   import { withOrg } from "@/lib/api/with-org";
 *
 *   export const GET = withOrg(async ({ db, user, orgId, scoped }, request) => {
 *     const rows = await db
 *       .select()
 *       .from(folders)
 *       .where(and(scoped(folders), eq(folders.mailboxId, mailboxId)));
 *     return NextResponse.json({ folders: rows });
 *   });
 *
 * Dynamic segments: the route context is the third argument, exactly as Next
 * hands it over.
 *
 *   export const PATCH = withOrg(
 *     async (ctx, request, { params }: { params: Promise<{ id: string }> }) => {
 *       const { id } = await params;
 *       ...
 *     },
 *   );
 *
 * Inserts: never hand-write `organizationId`, use `insertValues`.
 *
 *   await db.insert(folders).values(insertValues(folders, { id, userId, name }));
 *
 * API keys (only for routes that are part of the public API, e.g. `/api/v1/**`):
 *
 *   export const GET = withOrg(handler, { allowApiKey: true, requiredScope: "messages:read" });
 *
 * `requiredScope` must name an entry of the catalogue in `src/lib/api/scopes.ts`
 * — that is the only set of scopes a key can be issued with.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * 1. Authenticates. Cookie session first (`getUserFromSession`); then, when
 *    `options.allowApiKey` is set, `Authorization: Bearer ep_...` API keys.
 *    Disabled users and unknown credentials get 401.
 * 2. Enforces `options.requiredScope` on the API-key path (403 otherwise).
 *    Cookie sessions are unscoped (they get `["*"]`).
 * 3. Loads the organisation and rejects anything that is not `active` with
 *    403 `{"error":"Organisation suspended"}`.
 * 4. Enforces the organisation's two-factor policy on cookie sessions: when
 *    `organizations.require_two_factor` is set and the user has no
 *    `totp_enabled_at`, everything answers 403 `{"error":"two_factor_required"}`
 *    except the handful of routes needed to enrol (see `TWO_FACTOR_EXEMPT`).
 * 5. Calls the handler with an `OrgContext`.
 *
 * ---------------------------------------------------------------------------
 * RULES FOR HANDLERS
 * ---------------------------------------------------------------------------
 * - Every query on a tenant table (`TENANT_TABLES` below) must carry the org
 *   filter: put `scoped(table)` inside the `and(...)` of your `.where(...)`.
 * - Every insert into a tenant table goes through `insertValues(table, values)`.
 * - `conversation_notes` has no `organization_id` column on purpose: scope it
 *   through its parent conversation (`scoped(conversations)` on the join).
 * - The `require-org-scope` ESLint rule (`eslint-rules/require-org-scope.js`)
 *   checks both of the above. It is a warning today and becomes an error once
 *   every route folder is converted (T3.2).
 */
import { eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb, type AppDatabase } from "@/db";
import {
	apiKeys,
	auditLogs,
	calendarEvents,
	contacts,
	conversations,
	domains,
	emailTemplates,
	folders,
	inboundFailures,
	mailboxes,
	messages,
	routingRules,
	users,
	webhooks,
} from "@/db/schema";
import { authenticateApiKey, isApiAuthFailure, requireScope } from "@/lib/api/auth";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";
import { organizationRequiresTwoFactor } from "@/lib/auth/totp";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import {
	assertOrganizationActive,
	getOrganization,
	OrganizationSuspendedError,
	type OrganizationRef,
} from "@/lib/organizations/service";

/** Any table that carries `organization_id`. */
export type TenantTable = PgTable & { organizationId: AnyPgColumn };

/**
 * Every table with an `organization_id` column.
 *
 * `conversation_notes`, `message_attachments`, `mailbox_access`,
 * `webhook_deliveries`, `outbound_jobs`, `auto_reply_deliveries` and `sessions`
 * are deliberately absent: they have no org column and are scoped through their
 * parent row instead.
 */
export const TENANT_TABLES = [
	users,
	domains,
	mailboxes,
	messages,
	conversations,
	contacts,
	folders,
	apiKeys,
	webhooks,
	routingRules,
	emailTemplates,
	calendarEvents,
	auditLogs,
	inboundFailures,
] as const satisfies readonly TenantTable[];

/** The Next route context (`{ params }`) for the wrapped handler. */
export type RouteContext<P = Record<string, string | string[] | undefined>> = {
	params: Promise<P>;
};

/**
 * Who is making the request. Always a full user row, so the existing helpers
 * that take a `SessionUser` keep working; `kind` says how they authenticated.
 */
export type OrgPrincipal = SessionUser & {
	kind: "session" | "api_key";
	/** API-key scopes. Cookie sessions get `["*"]`. */
	scopes: string[];
	/** `api_keys.id` when `kind` is `api_key`; null for cookie sessions. */
	apiKeyId: string | null;
};

export type OrgContext = {
	env: AppEnv;
	db: AppDatabase;
	user: OrgPrincipal;
	org: OrganizationRef;
	/** Shorthand for `org.id`. */
	orgId: string;
	/** `eq(table.organizationId, orgId)` — drop it inside your `and(...)`. */
	scoped: <T extends TenantTable>(table: T) => SQL;
	/** Stamps `organizationId` onto insert values. */
	insertValues: OrgInsertValues;
};

export type WithOrgOptions = {
	/** Accept `Authorization: Bearer ep_...` API keys as well as cookies. */
	allowApiKey?: boolean;
	/** Scope the API key must hold (ignored on the cookie path). */
	requiredScope?: string;
};

/** `organizationId` is stamped on, so the caller must not (and need not) supply it. */
type OrgInsertInput<T extends TenantTable> = Omit<T["$inferInsert"], "organizationId">;

type OrgInsertValues = {
	<T extends TenantTable>(table: T, values: OrgInsertInput<T>): T["$inferInsert"];
	<T extends TenantTable>(table: T, values: OrgInsertInput<T>[]): T["$inferInsert"][];
};

function json(error: string, status: number): NextResponse {
	return NextResponse.json({ error }, { status });
}

/**
 * The routes a user must still reach while they are forced to enrol, otherwise
 * the requirement would lock them out of the very screens that satisfy it.
 *
 * Anything under `/api/auth/two-factor` (setup, enable, status), the session
 * endpoint the client polls, sign-out, and reading — never writing — the
 * organisation policy.
 */
function isTwoFactorEnrolmentRoute(request: Request): boolean {
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return false;
	}
	// Trailing slashes are normalised away so `/api/auth/me/` cannot slip past.
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	if (path === "/api/auth/two-factor" || path.startsWith("/api/auth/two-factor/")) return true;
	if (path === "/api/auth/me" || path === "/api/auth/logout") return true;
	if (path === "/api/settings/security" && request.method === "GET") return true;
	return false;
}

/**
 * 403 when the organisation forces two-factor and this session's user has not
 * enrolled. API keys are exempt: they are machine credentials with their own
 * scopes and revocation, and an agent cannot type a code.
 */
async function twoFactorGate(
	db: AppDatabase,
	orgId: string,
	request: Request,
	session: { enrolled: boolean } | null,
): Promise<NextResponse | null> {
	if (!session || session.enrolled) return null;
	if (isTwoFactorEnrolmentRoute(request)) return null;
	if (!(await organizationRequiresTwoFactor(db, orgId))) return null;
	return json("two_factor_required", 403);
}

/** Builds the `scoped`/`insertValues` pair for one organisation. */
export function createOrgScope(orgId: string): Pick<OrgContext, "scoped" | "insertValues"> {
	const scoped = <T extends TenantTable>(table: T): SQL => eq(table.organizationId, orgId);

	const insertValues = (<T extends TenantTable>(
		table: T,
		values: OrgInsertInput<T> | OrgInsertInput<T>[],
	) => {
		void table;
		return Array.isArray(values)
			? values.map((value) => ({ ...value, organizationId: orgId }))
			: { ...values, organizationId: orgId };
	}) as OrgInsertValues;

	return { scoped, insertValues };
}

/**
 * Wraps a route handler so it runs inside an authenticated, org-scoped context.
 * See the block at the top of this file for usage.
 */
export function withOrg<T extends RouteContext = RouteContext>(
	handler: (ctx: OrgContext, request: Request, routeCtx: T) => Promise<Response>,
	options: WithOrgOptions = {},
) {
	return async function orgRouteHandler(request: Request, routeCtx: T): Promise<Response> {
		const env = getEnv();
		const db = getDb(env);

		let principal: OrgPrincipal | null = null;
		/** Null on the API-key path; the enrolment state of the cookie session otherwise. */
		let session: { enrolled: boolean } | null = null;

		const jar = await cookies();
		const sessionUser = await getUserFromSession(env, jar.get(SESSION_COOKIE)?.value);
		if (sessionUser) {
			// Disabled accounts are treated as unauthenticated, never as forbidden.
			if (sessionUser.disabled) return json("Unauthorized", 401);
			principal = { ...sessionUser, kind: "session", scopes: ["*"], apiKeyId: null };
			session = { enrolled: !!sessionUser.totpEnabledAt };
		} else if (options.allowApiKey) {
			const auth = await authenticateApiKey(env, request.headers.get("authorization"), request);
			// A revoked or expired key is a real key in a bad state: say so, rather
			// than the generic "Unauthorized" used for credentials we don't know.
			if (isApiAuthFailure(auth)) return json(auth.message, 401);
			if (auth) {
				if (options.requiredScope && !requireScope(auth.scopes, options.requiredScope)) {
					return json("Insufficient scope", 403);
				}
				principal = {
					...auth.user,
					// The key's organisation wins over the owner's.
					organizationId: auth.organizationId,
					kind: "api_key",
					scopes: auth.scopes,
					apiKeyId: auth.apiKeyId,
				};
			}
		}

		if (!principal) return json("Unauthorized", 401);

		const org = await getOrganization(db, principal.organizationId);
		if (!org) return json("Organisation not found", 403);
		try {
			assertOrganizationActive(org);
		} catch (error) {
			if (error instanceof OrganizationSuspendedError) return json(error.message, 403);
			throw error;
		}

		const gated = await twoFactorGate(db, org.id, request, session);
		if (gated) return gated;

		const { scoped, insertValues } = createOrgScope(org.id);
		const ctx: OrgContext = {
			env,
			db,
			user: principal,
			org,
			orgId: org.id,
			scoped,
			insertValues,
		};

		return handler(ctx, request, routeCtx);
	};
}
