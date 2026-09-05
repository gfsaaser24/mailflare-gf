/**
 * `POST /api/auth/two-factor/enable` — finish enrolment.
 *
 * Body: `{ code, currentPassword }`. The code is checked against the pending
 * secret written by `/setup`, so a user cannot switch two-factor on for an
 * authenticator they have not actually paired.
 *
 * The backup codes in the response are the only time they exist in plain text.
 * Every other session for this user is dropped: sessions minted before the
 * second factor existed must not survive it.
 */
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { decryptSecret } from "@/lib/auth/crypto";
import { verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { generateBackupCodes, serializeBackupCodeHashes, verifyTotpCode } from "@/lib/auth/totp";
import { agentMailBlocksTwoFactor } from "@/lib/mailboxes/agent-mail";
import {
	asString,
	deleteOtherSessions,
	loadTwoFactorState,
	readTwoFactorBody,
	recordTwoFactorEvent,
} from "../shared";

export const POST = withOrg(async ({ db, env, user, orgId }, request) => {
	// Same refusal as `/setup`, checked again here: the flag can be set on a
	// mailbox between starting and finishing enrolment.
	const blocked = await agentMailBlocksTwoFactor(db, user.id, orgId);
	if (blocked) return NextResponse.json(blocked, { status: 400 });

	const body = await readTwoFactorBody(request);
	const code = asString(body.code);
	const currentPassword = asString(body.currentPassword);
	if (!code || !currentPassword) {
		return NextResponse.json(
			{ error: "Your password and a code from the authenticator app are both required." },
			{ status: 400 },
		);
	}

	if (!verifyPassword(currentPassword, user.passwordHash)) {
		return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
	}

	const state = await loadTwoFactorState(db, orgId, user.id);
	if (!state) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (state.totpEnabledAt) {
		return NextResponse.json(
			{ error: "Two-factor authentication is already on for this account." },
			{ status: 400 },
		);
	}
	if (!state.totpSecretEncrypted) {
		return NextResponse.json(
			{ error: "Start the setup step first, then enter a code." },
			{ status: 400 },
		);
	}

	let secret: string;
	try {
		secret = decryptSecret(env, state.totpSecretEncrypted);
	} catch {
		// The stored secret cannot be read (key rotated, row corrupt): the only
		// safe move is to make the user start again. The secret is never logged.
		return NextResponse.json(
			{ error: "The stored setup could not be read. Start the setup step again." },
			{ status: 400 },
		);
	}

	if (!(await verifyTotpCode(secret, code))) {
		return NextResponse.json({ error: "That code is not right. Try the next one." }, { status: 400 });
	}

	const { codes, hashes } = generateBackupCodes();
	await db
		.update(users)
		.set({ totpEnabledAt: new Date(), totpBackupCodes: serializeBackupCodeHashes(hashes) })
		.where(and(eq(users.organizationId, orgId), eq(users.id, user.id)));

	const jar = await cookies();
	await deleteOtherSessions(db, user.id, jar.get(SESSION_COOKIE)?.value);

	await recordTwoFactorEvent(env, {
		action: "auth.two_factor_enabled",
		userId: user.id,
		organizationId: orgId,
		request,
	});

	const response = NextResponse.json({ backupCodes: codes });
	response.headers.set("Cache-Control", "no-store");
	return response;
});
