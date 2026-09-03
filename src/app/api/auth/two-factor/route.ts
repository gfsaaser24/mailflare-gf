/** `GET /api/auth/two-factor` — the enrolment status the settings panel reads. */
import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { organizationRequiresTwoFactor, parseBackupCodeHashes } from "@/lib/auth/totp";
import { loadTwoFactorState } from "./shared";

export const GET = withOrg(async ({ db, user, orgId }) => {
	const state = await loadTwoFactorState(db, orgId, user.id);
	if (!state) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const enabled = !!state.totpEnabledAt;
	const response = NextResponse.json({
		enabled,
		enabledAt: state.totpEnabledAt ? state.totpEnabledAt.toISOString() : null,
		// Only meaningful once enrolled; a half-finished setup has no codes.
		backupCodesRemaining: enabled ? parseBackupCodeHashes(state.totpBackupCodes).length : 0,
		requiredByOrganization: await organizationRequiresTwoFactor(db, orgId),
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
});
