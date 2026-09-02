import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { backups } from "@/db/schema";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";

export const GET = withOrg<RouteContext<{ id: string }>>(
	async ({ db, env, user }, _request, { params }) => {
		try {
			assertAdmin(user);
			const { id } = await params;
			// `backups` is instance-level: no `organization_id` to scope by.
			const [backup] = await db.select().from(backups).where(eq(backups.id, id)).limit(1);
			if (!backup?.r2Key)
				return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
			const object = await env.BUCKET.get(backup.r2Key);
			if (!object) return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
			return new Response(object.body, {
				headers: {
					"Content-Type": "application/sql",
					"Content-Disposition": `attachment; filename="${backup.filename ?? `${backup.id}.sql`}"`,
					"Content-Length": String(object.size),
				},
			});
		} catch {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
	},
);
