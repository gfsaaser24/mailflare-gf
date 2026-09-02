import { NextResponse } from "next/server";
import { getExportConfigurationStatus } from "@/lib/backups/export";
import {
	createBackupRecord,
	getBackupSettings,
	listBackups,
	updateBackupSettings,
} from "@/lib/backups/service";
import { startBackup } from "@/lib/backups/utils";
import { reconcileStaleBackups } from "@/lib/backups/workflow";
import { getEnv } from "@/lib/cloudflare";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { parseBackupSettingsInput } from "./utils";

async function requireAdmin(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	assertAdmin(user);
	return { env, user };
}

export async function GET(request: Request) {
	try {
		const { env } = await requireAdmin(request);
		await reconcileStaleBackups(env);
		const [settings, backupList] = await Promise.all([
			getBackupSettings(env),
			listBackups(env),
		]);
		return NextResponse.json({
			settings,
			backups: backupList,
			configuration: getExportConfigurationStatus(env),
		});
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}

export async function PUT(request: Request) {
	try {
		const { env } = await requireAdmin(request);
		const input = parseBackupSettingsInput(await request.json());
		if (!input) return NextResponse.json({ error: "Invalid backup settings" }, { status: 400 });
		await updateBackupSettings(env, input);
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}

export async function POST(request: Request) {
	try {
		const { env, user } = await requireAdmin(request);
		const backupId = await createBackupRecord(env, "manual", user.id);
		startBackup(env, backupId);
		return NextResponse.json({ backupId }, { status: 202 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to start backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
