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
