import { and, eq, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { sessions, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session";
import type { ChangePasswordInput } from "./types";
import { parseChangePasswordRequest } from "./utils";

export const PATCH = withOrg(async ({ db, user, scoped }, request) => {
	let parsed: ChangePasswordInput;

	try {
		parsed = await parseChangePasswordRequest(request);
	} catch (err) {
		if (err instanceof ZodError) {
			return NextResponse.json({ error: err.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	if (!verifyPassword(parsed.currentPassword, user.passwordHash)) {
		return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
	}

	if (verifyPassword(parsed.newPassword, user.passwordHash)) {
		return NextResponse.json(
			{ error: "New password must be different from the current password" },
			{ status: 400 },
		);
	}

	// `password_changed_at` is the stamp anything issued before the change can be
	// measured against (one-time links, exported credentials).
	await db
		.update(users)
		.set({ passwordHash: hashPassword(parsed.newPassword), passwordChangedAt: new Date() })
		.where(and(scoped(users), eq(users.id, user.id)));

	// A password change must end every other login: if the old password leaked,
	// the sessions it already bought are the thing that has to die. The caller's
	// own session survives, matched by token hash so it can never revoke itself.
	const jar = await cookies();
	const token = jar.get(SESSION_COOKIE)?.value;
	const currentHash = token ? await hashSessionToken(token) : null;
	const revoked = await db
		.delete(sessions)
		.where(
			currentHash
				? and(eq(sessions.userId, user.id), ne(sessions.tokenHash, currentHash))
				: eq(sessions.userId, user.id),
		)
		.returning({ id: sessions.id });

	return NextResponse.json({ ok: true, revokedSessions: revoked.length });
});
