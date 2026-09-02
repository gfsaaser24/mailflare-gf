import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";

export const MAILFLARE_FORWARDED_HEADER = "x-mailflare-forwarded";

/**
 * Value the edge worker puts in MAILFLARE_FORWARDED_HEADER when it forwards a copy.
 * Derived from the shared secret so a sender cannot forge the marker and suppress forwarding.
 * Must match `forwardedMarker` in cloudflare-worker/src/index.ts.
 */
export function forwardedMarker(secret: string): string {
	return createHash("sha256").update(secret + ":forwarded").digest("hex").slice(0, 32);
}

export function hasTrustedForwardedFlag(headers: Record<string, string>, secret: string | undefined): boolean {
	if (!secret) return false;
	const expected = forwardedMarker(secret);
	const flag = MAILFLARE_FORWARDED_HEADER.toLowerCase();
	return Object.entries(headers).some(([key, value]) => key.toLowerCase() === flag && value.trim() === expected);
}

export async function getAccountForwardingDestination(
	env: CloudflareEnv,
	recipient: string,
): Promise<string | null> {
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, recipient);
	if (!decision?.mailbox) return null;
	const [account] = await db
		.select({ forwardingEmail: users.forwardingEmail })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	const destination = account?.forwardingEmail?.trim() ?? "";
	if (!destination || getEmailAddress(destination).toLowerCase() === getEmailAddress(recipient).toLowerCase()) {
		return null;
	}
	return destination;
}
