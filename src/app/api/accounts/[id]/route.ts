import { NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { users } from "@/db/schema";
import { updateManagedAccountSchema } from "@/lib/validators";
import { requireTeamAdmin } from "../utils";
import type { AccountRouteParams } from "./types";
import { selectAccountById, updateAccountCredentials } from "./utils";

// Arbitrary constant; all last-admin checks serialise on this advisory lock.
const LAST_ADMIN_LOCK_KEY = 7_291_004;

export async function GET(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const account = await selectAccountById(getDb(access.env), id);
	if (!account || (account.id !== access.user!.id && account.createdByUserId !== access.user!.id)) {
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
}

export async function PATCH(request: Request, { params }: AccountRouteParams) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const db = getDb(access.env);
	const account = await selectAccountById(db, id);
	if (!account || (account.id !== access.user!.id && account.createdByUserId !== access.user!.id)) {
		return NextResponse.json({ error: "Account not found" }, { status: 404 });
	}
	const parsed = updateManagedAccountSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	// An instance with no enabled admin reopens /api/auth/register and /api/setup/*
	// to the public internet, and mints the next anonymous registrant as admin.
	const losesAdmin = account.role === "admin" && (parsed.data.role !== "admin" || parsed.data.disabled);
	// Check and update run in one transaction under an advisory lock so two concurrent
	// requests cannot each see "another admin exists" and both remove the last one.
	const result = await db.transaction(async (tx) => {
		if (losesAdmin) {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK_KEY})`);
			const [otherAdmin] = await tx
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.role, "admin"), eq(users.disabled, false), ne(users.id, id)))
				.limit(1);
			if (!otherAdmin) return "last-admin" as const;
		}
		await updateAccountCredentials(tx, id, { name: parsed.data.name, password: null });
		await tx.update(users).set({
			role: parsed.data.role,
			disabled: parsed.data.disabled,
			canManageMailboxes: parsed.data.canManageMailboxes,
			...(parsed.data.forwardingEmail !== undefined ? { forwardingEmail: parsed.data.forwardingEmail } : {}),
		}).where(eq(users.id, id));
		return "ok" as const;
	});
	if (result === "last-admin") {
		return NextResponse.json({ error: "This instance must keep at least one active admin" }, { status: 409 });
	}
	return NextResponse.json({ ok: true });
}
