/**
 * `/login/two-factor` — the second step of a password login.
 *
 * Reachable only with a pending session cookie: without one there is nothing to
 * promote, so the user goes back to `/login` before any UI renders.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPendingTwoFactorSession, getUserFromSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { TwoFactorClient } from "./two-factor-client";

export const dynamic = "force-dynamic";

export default async function TwoFactorPage() {
	const env = getEnv();
	const cookieStore = await cookies();
	const token = cookieStore.get(SESSION_COOKIE)?.value;

	// Already fully signed in (e.g. a back-button visit): nothing to do here.
	const user = await getUserFromSession(env, token);
	if (user && !user.disabled) redirect("/inbox");

	const pending = await getPendingTwoFactorSession(env, token);
	if (!pending) redirect("/login");

	return <TwoFactorClient />;
}
