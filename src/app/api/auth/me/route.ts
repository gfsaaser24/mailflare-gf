import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { hasPrimaryDomain, userHasMailboxes } from "@/lib/user";

export const GET = withOrg(async ({ db, env, user, scoped }) => {
	// Read-only: the session user is re-read inside the request's organisation,
	// so a user row that does not belong to it can never be returned.
	const [row] = await db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			resetEmail: users.resetEmail,
			forwardingEmail: users.forwardingEmail,
			role: users.role,
			canManageMailboxes: users.canManageMailboxes,
			avatarKey: users.avatarKey,
		})
		.from(users)
		.where(and(scoped(users), eq(users.id, user.id)))
		.limit(1);
	if (!row) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let hasMailboxes = false;
	let isSetup = true;
	try {
		[hasMailboxes, isSetup] = await Promise.all([
			userHasMailboxes(env, row.id),
			hasPrimaryDomain(env),
		]);
	} catch {
		// Authentication remains valid when optional mailbox/setup metadata is unavailable.
	}
	return NextResponse.json({
		user: {
			id: row.id,
			email: row.email,
			name: row.name,
			resetEmail: row.resetEmail,
			forwardingEmail: row.forwardingEmail,
			canForwardEmail: true,
			role: row.role,
			canManageMailboxes: row.canManageMailboxes,
			hasAvatar: !!row.avatarKey,
		},
		hasMailboxes,
		isSetup,
	});
});
