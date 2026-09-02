import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiKeys } from "@/db/schema";
import { withOrg, type RouteContext } from "@/lib/api/with-org";

/**
 * Revokes a key. Revocation is a soft delete (`revoked_at`): the row stays so
 * the audit trail and `last_used_at` survive, and `authenticateApiKey` rejects
 * it from then on.
 *
 * Only the key's owner, inside the key's organisation, can revoke it. Anything
 * else is a 404 — an unrelated caller learns nothing about whether the id
 * exists.
 */
export const DELETE = withOrg(
	async ({ db, user, scoped }, _request, { params }: RouteContext<{ id: string }>) => {
		const { id } = await params;

		const revoked = await db
			.update(apiKeys)
			// Idempotent: revoking twice keeps the first timestamp.
			.set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
			.where(and(scoped(apiKeys), eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
			.returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });

		const row = revoked[0];
		if (!row) return NextResponse.json({ error: "API key not found" }, { status: 404 });

		return NextResponse.json({ id: row.id, revokedAt: row.revokedAt });
	},
);
