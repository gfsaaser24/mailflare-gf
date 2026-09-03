/**
 * `POST /api/auth/two-factor/backup-codes` — issue a fresh set of recovery codes.
 *
 * Body: `{ currentPassword }`. The old set is replaced outright, so codes that
 * were written down before this call stop working. The response is the only
 * place the new codes exist in plain text.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { verifyPassword } from "@/lib/auth/password";
import { generateBackupCodes, serializeBackupCodeHashes } from "@/lib/auth/totp";
import { asString, loadTwoFactorState, readTwoFactorBody } from "../shared";

export const POST = withOrg(async ({ db, user, orgId }, request) => {
	const body = await readTwoFactorBody(request);
	const currentPassword = asString(body.currentPassword);
	if (!currentPassword) {
		return NextResponse.json({ error: "Your password is required." }, { status: 400 });
	}
	if (!verifyPassword(currentPassword, user.passwordHash)) {
		return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
	}

	const state = await loadTwoFactorState(db, orgId, user.id);
	if (!state) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!state.totpEnabledAt) {
		return NextResponse.json(
			{ error: "Turn on two-factor authentication first." },
			{ status: 400 },
		);
	}

	const { codes, hashes } = generateBackupCodes();
	await db
		.update(users)
		.set({ totpBackupCodes: serializeBackupCodeHashes(hashes) })
		.where(and(eq(users.organizationId, orgId), eq(users.id, user.id)));

	const response = NextResponse.json({ backupCodes: codes });
	response.headers.set("Cache-Control", "no-store");
	return response;
});
