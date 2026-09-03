/**
 * `/forgot-password` — asks for a reset link.
 *
 * No session is needed and none is checked: the page is reachable by someone
 * who cannot sign in, which is the whole point. Rendered dynamically so Next's
 * inline scripts carry the CSP nonce (see `src/lib/security/headers.ts`).
 */
import { ForgotPasswordClient } from "./forgot-password-client";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
	return <ForgotPasswordClient />;
}
