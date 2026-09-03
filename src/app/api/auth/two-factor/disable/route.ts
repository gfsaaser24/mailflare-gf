/**
 * `POST /api/auth/two-factor/disable` — turn two-factor off.
 *
 * Body: `{ currentPassword, code }`, where the code may be a TOTP code or a
 * backup code (someone who lost the authenticator still has to be able to get
 * out). Both are required: a stolen session alone must not be able to strip the
 * second factor.
 *
 * Refused with 403 `two_factor_required` while the organisation requires it.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { decryptSecret } from "@/lib/auth/crypto";
import { verifyPassword } from "@/lib/auth/password";
import {
	consumeBackupCode,
	isBackupCodeFormat,
	organizationRequiresTwoFactor,
	verifyTotpCode,
} from "@/lib/auth/totp";
import { asString, loadTwoFactorState, readTwoFactorBody, recordTwoFactorEvent } from "../shared";

export const POST = withOrg(async ({ db, env, user, orgId }, request) => {
	if (await organizationRequiresTwoFactor(db, orgId)) {
		return NextResponse.json({ error: "two_factor_required" }, { status: 403 });
	}

	const body = await readTwoFactorBody(request);
	const code = asString(body.code);
	const currentPassword = asString(body.currentPassword);
	if (!code || !currentPassword) {
		return NextResponse.json(
			{ error: "Your password and a code are both required." },
			{ status: 400 },
		);
	}

	if (!verifyPassword(currentPassword, user.passwordHash)) {
		return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
	}

	const state = await loadTwoFactorState(db, orgId, user.id);
	if (!state) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!state.totpEnabledAt) {
		return NextResponse.json(
			{ error: "Two-factor authentication is not on for this account." },
			{ status: 400 },
		);
	}

	let accepted = false;
	let method: "totp" | "backup_code" = "totp";
	if (isBackupCodeFormat(code)) {
		accepted = consumeBackupCode(state.totpBackupCodes, code).matched;
		method = "backup_code";
	} else if (state.totpSecretEncrypted) {
		try {
			accepted = await verifyTotpCode(decryptSecret(env, state.totpSecretEncrypted), code);
		} catch {
			accepted = false;
		}
	}
	if (!accepted) {
		return NextResponse.json({ error: "That code is not right. Try again." }, { status: 400 });
	}

	// The burnt backup code is irrelevant: the whole set goes with the secret.
	await db
		.update(users)
		.set({ totpSecretEncrypted: null, totpEnabledAt: null, totpBackupCodes: null })
		.where(and(eq(users.organizationId, orgId), eq(users.id, user.id)));

	await recordTwoFactorEvent(env, {
		action: "auth.two_factor_disabled",
		userId: user.id,
		organizationId: orgId,
		request,
		details: { method },
	});

	const response = NextResponse.json({ ok: true });
	response.headers.set("Cache-Control", "no-store");
	return response;
});
