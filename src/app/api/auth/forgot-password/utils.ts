import { z } from "zod";
import { getAuthActivityMetadata } from "@/lib/auth/activity";
import { createAuditLog } from "@/lib/mailboxes/audit";

/** How long a reset link stays usable. */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export const forgotPasswordSchema = z.object({
	email: z.string().email().max(320),
});

/** The key both the lookup and the per-email rate limit use. */
export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** In-flight deferred mail, so a test can wait for it. Empty in steady state. */
const inFlightAuthMail = new Set<Promise<void>>();

/**
 * Runs the "issue a token and mail it" half of a recovery request OFF the
 * response path.
 *
 * `/api/auth/forgot-password` and `/api/auth/magic-link` answer the same
 * `200 {ok:true}` for every input, but they used to await a token insert and an
 * HTTP call to the edge worker for a known address and return after a single
 * SELECT for an unknown one. The status and body matched; the wall clock did
 * not, which is the same account-existence oracle wearing a stopwatch. Handing
 * the work to a detached promise makes every input leave by the same code path
 * after the same work.
 *
 * Failures are logged with the label only — never the token, never the address.
 */
export function deferRecoveryWork(label: string, work: () => Promise<void>): void {
	const task: Promise<void> = work()
		.catch((error) => {
			console.error(`${label} could not be sent`, error instanceof Error ? error.message : error);
		})
		.finally(() => {
			inFlightAuthMail.delete(task);
		});
	inFlightAuthMail.add(task);
}

/**
 * Test-only: resolves once every deferred recovery task has settled. Production
 * code never calls it — the whole point is that nothing waits.
 */
export async function flushRecoveryWork(): Promise<void> {
	while (inFlightAuthMail.size > 0) {
		await Promise.all([...inFlightAuthMail]);
	}
}

export type RecoveryAction =
	| "auth.password_reset_requested"
	| "auth.password_reset"
	| "auth.magic_link_requested";

/**
 * The audit row for a recovery event.
 *
 * `recordAuthActivity` is the usual door, but its `action` union lives in
 * `src/lib/auth/activity-types.d.ts` and still only names login/logout/invite.
 * That file is outside this change, so the row is written through the same two
 * helpers `recordAuthActivity` itself uses and comes out identical. Collapse
 * this back into `recordAuthActivity` once the union is widened.
 */
export async function recordRecoveryActivity(
	env: CloudflareEnv,
	input: {
		action: RecoveryAction;
		userId: string;
		request: Request;
		details?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		await createAuditLog(env, {
			actorUserId: input.userId,
			targetUserId: input.userId,
			action: input.action,
			metadata: { ...getAuthActivityMetadata(input.request), ...(input.details ?? {}) },
		});
	} catch {
		// Recovery must not fail because the audit trail is unavailable.
	}
}
