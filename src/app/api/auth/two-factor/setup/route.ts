/**
 * `POST /api/auth/two-factor/setup` — start enrolment.
 *
 * Mints a shared secret, stores it encrypted with `totp_enabled_at` still null
 * (so nothing about the login flow changes yet) and hands back the QR code.
 * This is the ONLY response that ever contains the plaintext secret: the user
 * needs it for manual entry when they cannot scan.
 *
 * Calling it again before `/enable` replaces the pending secret, which is what
 * you want when someone abandons the flow or loses the half-set-up entry.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { encryptSecret } from "@/lib/auth/crypto";
import { buildOtpauthUrl, generateTotpSecret, getTotpIssuer } from "@/lib/auth/totp";
import { loadTwoFactorState } from "../shared";

export const POST = withOrg(async ({ db, env, user, orgId }) => {
	const state = await loadTwoFactorState(db, orgId, user.id);
	if (!state) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (state.totpEnabledAt) {
		return NextResponse.json(
			{ error: "Two-factor authentication is already on for this account." },
			{ status: 400 },
		);
	}

	const secret = generateTotpSecret();
	let encrypted: string;
	try {
		encrypted = encryptSecret(env, secret);
	} catch (error) {
		// AUTH_ENCRYPTION_KEY missing or malformed: a deployment problem, not a
		// user error, and the message from crypto.ts says exactly what to do.
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Cannot encrypt the secret" },
			{ status: 500 },
		);
	}

	await db
		.update(users)
		.set({ totpSecretEncrypted: encrypted, totpEnabledAt: null, totpBackupCodes: null })
		.where(and(eq(users.organizationId, orgId), eq(users.id, user.id)));

	const otpauthUrl = buildOtpauthUrl({
		issuer: await getTotpIssuer(env),
		label: user.email,
		secret,
	});
	const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });

	const response = NextResponse.json({ otpauthUrl, qrDataUrl, secret });
	response.headers.set("Cache-Control", "no-store");
	return response;
});
