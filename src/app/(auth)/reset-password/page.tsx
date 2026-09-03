/**
 * `/reset-password?token=…` — sets a new password from a reset link.
 *
 * The token is only carried to the client so it can be POSTed in a request
 * body; nothing here validates it, because validating it would have to spend it
 * and a link previewer opening the page would then break the real user's reset.
 */
import { ResetPasswordClient } from "./reset-password-client";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
	searchParams,
}: {
	searchParams: Promise<{ token?: string | string[] }>;
}) {
	const { token } = await searchParams;
	const value = Array.isArray(token) ? token[0] : token;
	return <ResetPasswordClient token={value ?? ""} />;
}
