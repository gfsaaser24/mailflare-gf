/**
 * Platform console shell (T3.4).
 *
 * The gate is **server-side and here only**: `/api/platform/**` already refuses
 * everybody else, but the console must not even render for a tenant admin. It
 * reads the same `ep_session` cookie the API guard reads
 * (`src/lib/platform/guard.ts`) and applies the same three rules — no session,
 * disabled or impersonating means "not an operator".
 *
 * Non-operators go to `/inbox` rather than seeing a 403: they are legitimate
 * users of the app, just not of this plane.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { SESSION_COOKIE, getUserFromSession } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { isPlatformOperator } from "@/lib/platform/guard";
import { PlatformShell } from "@/components/platform/platform-shell";

export const dynamic = "force-dynamic";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
	const env = getEnv();
	const jar = await cookies();
	const user = await getUserFromSession(env, jar.get(SESSION_COOKIE)?.value);

	if (!user || user.disabled) redirect("/login");
	// An impersonation session must never re-enter the platform plane.
	if (user.impersonatedByUserId) redirect("/inbox");
	if (!(await isPlatformOperator(getDb(env), user.id))) redirect("/inbox");

	return <PlatformShell operatorEmail={user.email}>{children}</PlatformShell>;
}
