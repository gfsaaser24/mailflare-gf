/**
 * Pieces every `/api/auth/two-factor/**` route needs.
 *
 * Not a route file: only `route.ts` is served by the App Router.
 */
import { and, eq, ne } from "drizzle-orm";
import { sessions, users } from "@/db/schema";
import type { AppDatabase } from "@/db";
import { getAuthActivityMetadata } from "@/lib/auth/activity";
import { hashSessionToken } from "@/lib/auth/session";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { readJsonBody } from "@/lib/http/request";

/** Bodies here are a password and a code; 4 KiB is generous. */
const MAX_BODY_BYTES = 4 * 1024;

export type TwoFactorBody = {
	code?: unknown;
	currentPassword?: unknown;
};

/** Reads the JSON body, treating anything unparseable as empty. */
export async function readTwoFactorBody(request: Request): Promise<TwoFactorBody> {
	try {
		return await readJsonBody<TwoFactorBody>(request, MAX_BODY_BYTES);
	} catch {
		return {};
	}
}

/** A required string field, trimmed; empty and non-strings come back as "". */
export function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Signs the user out everywhere else. Called when two-factor is switched on, so
 * a session that predates the new requirement cannot outlive it.
 *
 * The current session is identified by the hash of its cookie token, so the
 * browser that just enrolled stays signed in.
 */
export async function deleteOtherSessions(
	db: AppDatabase,
	userId: string,
	currentToken: string | undefined,
): Promise<void> {
	if (!currentToken) {
		await db.delete(sessions).where(eq(sessions.userId, userId));
		return;
	}
	const currentHash = await hashSessionToken(currentToken);
	await db
		.delete(sessions)
		.where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, currentHash)));
}

/**
 * Audit entry for the two-factor lifecycle.
 *
 * `recordAuthActivity` only accepts the actions in `AuthActivityAction`, so the
 * enable/disable events go straight to `createAuditLog` with the same request
 * metadata attached.
 */
export async function recordTwoFactorEvent(
	env: CloudflareEnv,
	input: {
		action: "auth.two_factor_enabled" | "auth.two_factor_disabled";
		userId: string;
		organizationId: string;
		request: Request;
		details?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		await createAuditLog(env, {
			organizationId: input.organizationId,
			actorUserId: input.userId,
			targetUserId: input.userId,
			action: input.action,
			metadata: { ...getAuthActivityMetadata(input.request), ...(input.details ?? {}) },
		});
	} catch {
		// Enrolment must not fail because the audit write did.
	}
}

/** Reads the current user's two-factor columns inside the request's organisation. */
export async function loadTwoFactorState(
	db: AppDatabase,
	organizationId: string,
	userId: string,
): Promise<{
	totpSecretEncrypted: string | null;
	totpEnabledAt: Date | null;
	totpBackupCodes: string | null;
} | null> {
	const [row] = await db
		.select({
			totpSecretEncrypted: users.totpSecretEncrypted,
			totpEnabledAt: users.totpEnabledAt,
			totpBackupCodes: users.totpBackupCodes,
		})
		.from(users)
		.where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
		.limit(1);
	return row ?? null;
}
