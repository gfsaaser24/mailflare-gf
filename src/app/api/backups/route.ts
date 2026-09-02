import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { getExportConfigurationStatus } from "@/lib/backups/export";
import {
	createBackupRecord,
	getBackupSettings,
	listBackups,
	updateBackupSettings,
} from "@/lib/backups/service";
import { startBackup } from "@/lib/backups/utils";
import { reconcileStaleBackups } from "@/lib/backups/workflow";
import { parseBackupSettingsInput } from "./utils";

// `backups`, `backup_settings` and `app_settings` are instance-level tables with
// no `organization_id`. `withOrg` here is authentication plus the suspended-org
// check only; the admin check is unchanged.

export const GET = withOrg(async ({ env, user }) => {
	try {
		assertAdmin(user);
		await reconcileStaleBackups(env);
		const [settings, backupList] = await Promise.all([getBackupSettings(env), listBackups(env)]);
		return NextResponse.json({
			settings,
			backups: backupList,
			configuration: getExportConfigurationStatus(env),
		});
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
});

export const PUT = withOrg(async ({ env, user }, request) => {
	try {
		assertAdmin(user);
		const input = parseBackupSettingsInput(await request.json());
		if (!input) return NextResponse.json({ error: "Invalid backup settings" }, { status: 400 });
		await updateBackupSettings(env, input);
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
});

export const POST = withOrg(async ({ env, user }) => {
	try {
		assertAdmin(user);
		const backupId = await createBackupRecord(env, "manual", user.id);
		startBackup(env, backupId);
		return NextResponse.json({ backupId }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to start backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
});
