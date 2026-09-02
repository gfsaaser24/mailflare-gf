import { NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";

import { users } from "@/db/schema";
import { disableUser } from "@/lib/accounts/service";
import { withOrg } from "@/lib/api/with-org";
import { updateManagedAccountSchema } from "@/lib/validators";
import { requireTeamAdmin } from "../utils";
import type { AccountRouteParams } from "./types";
import { getManagedAccount, updateAccountCredentials } from "./utils";

// Arbitrary constant; all last-admin checks serialise on this advisory lock.
const LAST_ADMIN_LOCK_KEY = 7_291_004;

export const GET = withOrg<AccountRouteParams>(async (ctx, _request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const account = await getManagedAccount(ctx, id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	return NextResponse.json({
		account: {
			id: account.id,
			email: account.email,
			name: account.name,
			role: account.role,
			disabled: account.disabled,
			canManageMailboxes: account.canManageMailboxes,
			forwardingEmail: account.forwardingEmail,
			canForwardEmail: true,
			hasAvatar: !!account.avatarKey,
		},
	});
});

export const PATCH = withOrg<AccountRouteParams>(async (ctx, request, { params }) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const { id } = await params;
	const { db, orgId } = ctx;
	const account = await getManagedAccount(ctx, id);
	if (!account) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const parsed = updateManagedAccountSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	// An organisation with no enabled admin can no longer administer itself, and an
	// instance with no enabled admin reopens /api/auth/register and /api/setup/* to the
	// public internet, and mints the next anonymous registrant as admin.
	const losesAdmin = account.role === "admin" && (parsed.data.role !== "admin" || parsed.data.disabled);
	// Check and update run in one transaction under an advisory lock so two concurrent
	// requests cannot each see "another admin exists" and both remove the last one.
	const result = await db.transaction(async (tx) => {
		if (losesAdmin) {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK_KEY})`);
			const [otherAdmin] = await tx
				.select({ id: users.id })
				.from(users)
				.where(
					and(
						eq(users.organizationId, orgId),
						eq(users.role, "admin"),
						eq(users.disabled, false),
						ne(users.id, id),
					),
				)
				.limit(1);
			if (!otherAdmin) return "last-admin" as const;
		}
		await updateAccountCredentials(tx, orgId, id, { name: parsed.data.name, password: null });
		await tx.update(users).set({
			role: parsed.data.role,
			disabled: parsed.data.disabled,
			canManageMailboxes: parsed.data.canManageMailboxes,
			...(parsed.data.forwardingEmail !== undefined ? { forwardingEmail: parsed.data.forwardingEmail } : {}),
		}).where(and(eq(users.organizationId, orgId), eq(users.id, id)));
		return "ok" as const;
	});
	if (result === "last-admin") {
		return NextResponse.json({ error: "This instance must keep at least one active admin" }, { status: 409 });
	}
	// Disabling is not just a flag: `disableUser` also revokes every session the
	// account still holds, so it is out now rather than at the next expiry (T3.5).
	if (parsed.data.disabled) await disableUser(db, orgId, id);
	return NextResponse.json({ ok: true });
});
