import { NextResponse } from "next/server";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { deleteBackup } from "@/lib/backups/service";

export const DELETE = withOrg<RouteContext<{ id: string }>>(
	async ({ env, user }, _request, { params }) => {
		try {
			assertAdmin(user);
			const { id } = await params;
			const deleted = await deleteBackup(env, id);
			if (!deleted) return NextResponse.json({ error: "Backup not found" }, { status: 404 });
			return NextResponse.json({ ok: true });
		} catch {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
	},
);
