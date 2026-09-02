import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { auditLogs, domains, mailboxes, users } from "@/db/schema";
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
	const targetUsers = alias(users, "target_users");
	const rows = await db
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
			targetEmail: targetUsers.email,
			mailboxLocalPart: mailboxes.localPart,
			mailboxHostname: domains.hostname,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.leftJoin(targetUsers, eq(targetUsers.id, auditLogs.targetUserId))
		.leftJoin(mailboxes, eq(mailboxes.id, auditLogs.mailboxId))
		.leftJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(and(scoped(auditLogs), inArray(auditLogs.action, ["auth.login", "auth.logout"])))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ auditLogs: rows });
});
