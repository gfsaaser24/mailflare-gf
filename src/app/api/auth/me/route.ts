import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
// The single sanctioned read of `platform_operators` outside `/api/platform/**`:
// the console nav has to know whether to show the "Platform" link, and this is
// the only session endpoint the client already calls on every page.
import { isPlatformOperator } from "@/lib/platform/guard";
import { organizationRequiresTwoFactor } from "@/lib/auth/totp";
import { ownsAgentMailMailbox } from "@/lib/mailboxes/agent-mail";
import { hasPrimaryDomain, userHasMailboxes } from "@/lib/user";

export const GET = withOrg(async ({ db, env, user, orgId, scoped }) => {
	// Read-only: the session user is re-read inside the request's organisation,
	// so a user row that does not belong to it can never be returned.
	const [row] = await db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			resetEmail: users.resetEmail,
			forwardingEmail: users.forwardingEmail,
			role: users.role,
			canManageMailboxes: users.canManageMailboxes,
			avatarKey: users.avatarKey,
			totpEnabledAt: users.totpEnabledAt,
		})
		.from(users)
		.where(and(scoped(users), eq(users.id, user.id)))
		.limit(1);
	if (!row) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// An impersonation session never counts as an operator: the guard refuses it,
	// so the console link would only lead to a 403.
	let platformOperator = false;
	if (!user.impersonatedByUserId) {
		try {
			platformOperator = await isPlatformOperator(db, user.id);
		} catch {
			// Session validity must not depend on the platform table being present.
		}
	}

	// The client uses this to send a user who must enrol to the settings panel;
	// `withOrg()` is what actually blocks the rest of the API.
	//
	// An owner of an agent mailbox cannot enrol at all, so the same exemption
	// `withOrg()` applies is reported here: `requiredByOrganization` reads false
	// for them (no redirect loop) and `blockedByAgentMail` says why.
	let requiredByOrganization = false;
	let blockedByAgentMail = false;
	try {
		[requiredByOrganization, blockedByAgentMail] = await Promise.all([
			organizationRequiresTwoFactor(db, orgId),
			ownsAgentMailMailbox(db, user.id, orgId),
		]);
	} catch {
		// A policy read that fails must not invalidate the session.
	}

	let hasMailboxes = false;
	let isSetup = true;
	try {
		[hasMailboxes, isSetup] = await Promise.all([
			userHasMailboxes(env, row.id),
			hasPrimaryDomain(env),
		]);
	} catch {
		// Authentication remains valid when optional mailbox/setup metadata is unavailable.
	}
	return NextResponse.json({
		user: {
			id: row.id,
			email: row.email,
			name: row.name,
			resetEmail: row.resetEmail,
			forwardingEmail: row.forwardingEmail,
			canForwardEmail: true,
			role: row.role,
			canManageMailboxes: row.canManageMailboxes,
			hasAvatar: !!row.avatarKey,
			/** Set when a platform operator minted this session (T3.3). */
			impersonatedByUserId: user.impersonatedByUserId ?? null,
			isPlatformOperator: platformOperator,
		},
		hasMailboxes,
		isSetup,
		twoFactor: {
			enabled: !!row.totpEnabledAt,
			requiredByOrganization: requiredByOrganization && !blockedByAgentMail,
			blockedByAgentMail,
		},
	});
});
