import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { mailboxes, users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import { createUserAccountSchema } from "@/lib/validators";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { isQuotaExceededError, quotaErrorBody } from "@/lib/quotas/errors";
import { releaseQuota, reserveQuota } from "@/lib/quotas/service";
import type { CreateUserAccountInput } from "./types";
import {
	accountListItemFromUser,
	getDomainForAdmin,
	getExistingMailbox,
	listAccountsForAdmin,
	requireTeamAdmin,
} from "./utils";

export const GET = withOrg(async (ctx) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;
	const rows = await listAccountsForAdmin(ctx.db, ctx.user.id, ctx.orgId);
	return NextResponse.json({
		accounts: rows.map((row) => accountListItemFromUser(row)),
	});
});

export const POST = withOrg(async (ctx, request) => {
	const forbidden = requireTeamAdmin(ctx);
	if (forbidden) return forbidden;

	const parsed = createUserAccountSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const input: CreateUserAccountInput = parsed.data;
	const { db, env, insertValues } = ctx;
	const domain = await getDomainForAdmin(ctx, ctx.user.id, input.domainId);
	if (!domain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	const username = input.username.toLowerCase().trim();
	const email = `${username}@${domain.hostname}`;
	// users.email is unique across the whole instance, so this one lookup stays global:
	// an org-scoped check would answer 409 late, as a unique-violation crash.
	// eslint-disable-next-line mailflare/require-org-scope -- global uniqueness check, reveals no org data
	const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
	if (existing) return NextResponse.json({ error: "Email already registered" }, { status: 409 });
	const mailbox = await getExistingMailbox(ctx, domain.id, username);
	if (mailbox) return NextResponse.json({ error: "Email address is already assigned" }, { status: 409 });

	// Quota (T5.1): an account is one user plus its personal mailbox, booked under
	// the org usage lock before anything is written.
	const quotaIncrement = { accounts: 1, mailboxes: 1 };
	try {
		await reserveQuota(db, ctx.orgId, quotaIncrement);
	} catch (error) {
		if (isQuotaExceededError(error)) {
			return NextResponse.json(quotaErrorBody(error), { status: error.status });
		}
		throw error;
	}

	const userId = newId("usr");
	try {
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, email);
		const [account] = await db
			.insert(users)
			.values(
				insertValues(users, {
					id: userId,
					email,
					passwordHash: hashPassword(input.password),
					name: username,
					role: input.role,
					createdByUserId: ctx.user.id,
				}),
			)
			.returning({
				id: users.id,
				email: users.email,
				name: users.name,
				resetEmail: users.resetEmail,
				role: users.role,
				disabled: users.disabled,
				createdAt: users.createdAt,
			});
		const mailboxId = newId("mbx");
		await db.insert(mailboxes).values(
			insertValues(mailboxes, {
				id: mailboxId,
				userId,
				domainId: domain.id,
				localPart: username,
				displayName: username,
			}),
		);
		await ensureMailboxDomainRouting(
			env,
			db,
			{ id: mailboxId, domainId: domain.id, localPart: username, useAllDomains: true },
			ctx.orgId,
		);

		return NextResponse.json({ account: accountListItemFromUser(account) }, { status: 201 });
	} catch (error) {
		await db.delete(users).where(and(ctx.scoped(users), eq(users.id, userId)));
		await releaseQuota(db, ctx.orgId, quotaIncrement);
		const message = error instanceof Error ? error.message : "Failed to create account mailbox";
		return NextResponse.json({ error: message }, { status: 502 });
	}
});
