import { and, desc, inArray, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auditLogs, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";

export const GET = withOrg(async ({ db, user, scoped }, request) => {
	try {
		assertAdmin(user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
	const rows = await db
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.where(and(scoped(auditLogs), inArray(auditLogs.action, ["auth.login", "auth.logout"])))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ activities: rows });
});
