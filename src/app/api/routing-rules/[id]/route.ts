import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { folders, routingRules } from "@/db/schema";
import { withOrg, type RouteContext } from "@/lib/api/with-org";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { routingRuleSchema } from "@/lib/validators";

type Params = RouteContext<{ id: string }>;

export const PATCH = withOrg<Params>(
	async ({ db, user, orgId, scoped }, request, { params }) => {
		const { id } = await params;
		const parsed = routingRuleSchema.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
		}

		const [rule] = await db
			.select()
			.from(routingRules)
			.where(and(scoped(routingRules), eq(routingRules.id, id)))
			.limit(1);
		if (!rule?.mailboxId || rule.mailboxId !== parsed.data.mailboxId) {
			return NextResponse.json({ error: "Rule not found" }, { status: 404 });
		}
		// The mailbox must be in this organisation too: the rule is only reachable
		// through it.
		const access = await getMailboxAccessLevel(db, user, rule.mailboxId, orgId);
		if (!access?.canManage) {
			return NextResponse.json({ error: "Rule not found" }, { status: 404 });
		}

		const destination = parsed.data.destination ?? (parsed.data.folderId ? `folder:${parsed.data.folderId}` : "");
		const systemAction = destination === "spam" || destination === "trash" ? destination : null;
		const folderId = destination.startsWith("folder:") ? destination.slice("folder:".length) : null;
		if (!systemAction && !folderId) {
			return NextResponse.json({ error: "Destination is required" }, { status: 400 });
		}
		if (folderId) {
			const [folder] = await db
				.select()
				.from(folders)
				.where(and(scoped(folders), eq(folders.id, folderId), eq(folders.mailboxId, rule.mailboxId)))
				.limit(1);
			if (!folder) {
				return NextResponse.json({ error: "Folder not found" }, { status: 404 });
			}
		}

		await db
			.update(routingRules)
			.set({
				pattern: parsed.data.matchValue.trim(),
				matchField: parsed.data.matchField,
				matchOperator: parsed.data.matchOperator,
				matchValue: parsed.data.matchValue.trim(),
				action: systemAction ?? "store",
				folderId,
				forwardTo: null,
				priority: parsed.data.priority,
			})
			.where(and(scoped(routingRules), eq(routingRules.id, id)));

		return NextResponse.json({ ok: true });
	},
);

export const DELETE = withOrg<Params>(async ({ db, user, orgId, scoped }, _request, { params }) => {
	const { id } = await params;
	const [rule] = await db
		.select()
		.from(routingRules)
		.where(and(scoped(routingRules), eq(routingRules.id, id)))
		.limit(1);
	if (!rule?.mailboxId) {
		return NextResponse.json({ error: "Rule not found" }, { status: 404 });
	}
	const access = await getMailboxAccessLevel(db, user, rule.mailboxId, orgId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Rule not found" }, { status: 404 });
	}

	await db.delete(routingRules).where(and(scoped(routingRules), eq(routingRules.id, id)));

	return NextResponse.json({ ok: true });
});
