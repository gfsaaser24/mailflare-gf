import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getUserFromSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { LoginClient } from "./login-client";

/**
 * The one and only login screen. `/login` and `/` (`src/app/page.tsx`) both
 * render this, so there is a single implementation of the form, its chrome and
 * its redirects. Keep the behaviour here, never in a copy.
 */
export async function LoginScreen() {
	const env = getEnv();
	if (!(await hasAdminAccount(env))) redirect("/setup");
	const cookieStore = await cookies();
	const user = await getUserFromSession(env, cookieStore.get(SESSION_COOKIE)?.value);
	if (user && !user.disabled) redirect("/inbox");

	return (
		<AuthGuard mode="public">
			<LoginClient />
		</AuthGuard>
	);
}
