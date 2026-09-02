import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { restoreDatabaseRecords } from "@/lib/backups/export";

export const POST = withOrg(async ({ db, user }, request) => {
	try {
		assertAdmin(user);
		const form = await request.formData();
		const file = form.get("backup");
		if (!(file instanceof File))
			return NextResponse.json({ error: "Choose a backup file" }, { status: 400 });
		await restoreDatabaseRecords(db, await file.arrayBuffer());
		return NextResponse.json({ ok: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to restore backup";
		return NextResponse.json({ error: message }, { status: 400 });
	}
});
