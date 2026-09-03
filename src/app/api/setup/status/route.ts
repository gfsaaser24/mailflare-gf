import { NextResponse } from "next/server";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getEnv } from "@/lib/cloudflare";
import { getPrimaryDomain } from "@/lib/user";

/**
 * Unauthenticated: the setup wizard has to ask it before anybody can sign in.
 *
 * Because of that, the hostname is only disclosed while the instance is still
 * unclaimed (`hasAdminAccount === false`), which is exactly when the register
 * screen needs it. Once an admin exists the flag stays but `primaryDomain` goes
 * to null, so a configured deployment leaks nothing to an anonymous caller.
 */
export async function GET() {
	const env = getEnv();
	try {
		const [adminAccountExists, domain] = await Promise.all([
			hasAdminAccount(env),
			getPrimaryDomain(env),
		]);
		return NextResponse.json({
			hasAdminAccount: adminAccountExists,
			hasPrimaryDomain: !!domain,
			primaryDomain: !adminAccountExists && domain ? { hostname: domain.hostname } : null,
		}, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not load setup status";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
