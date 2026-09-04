import { LoginScreen } from "./(auth)/login/login-page";

export const dynamic = "force-dynamic";

/** The root of the app is the login form; there is no marketing landing page. */
export default function HomePage() {
	return <LoginScreen />;
}
