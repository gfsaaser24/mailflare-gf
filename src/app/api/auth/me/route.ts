import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { hasPrimaryDomain, userHasMailboxes } from "@/lib/user";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let hasMailboxes = false;
	let isSetup = true;
	try {
		[hasMailboxes, isSetup] = await Promise.all([
			userHasMailboxes(env, user.id),
			hasPrimaryDomain(env),
		]);
	} catch {
		// Authentication remains valid when optional mailbox/setup metadata is unavailable.
	}
	return NextResponse.json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			resetEmail: user.resetEmail,
			forwardingEmail: user.forwardingEmail,
			canForwardEmail: true,
			role: user.role,
			canManageMailboxes: user.canManageMailboxes,
			hasAvatar: !!user.avatarKey,
		},
		hasMailboxes,
		isSetup,
	});
}
