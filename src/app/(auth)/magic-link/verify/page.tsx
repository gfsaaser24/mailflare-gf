/**
 * `/magic-link/verify?token=…` — the page a sign-in link lands on.
 *
 * Nothing is spent on GET. Mail scanners, link previewers and prefetchers fetch
 * every URL in a message; if opening this page logged in, the first scanner to
 * touch it would burn the link and hand a session to whoever ran the scanner.
 * The user has to press the button, which POSTs the token.
 */
import { MagicLinkVerifyClient } from "./verify-client";

export const dynamic = "force-dynamic";

export default async function MagicLinkVerifyPage({
	searchParams,
}: {
	searchParams: Promise<{ token?: string | string[] }>;
}) {
	const { token } = await searchParams;
	const value = Array.isArray(token) ? token[0] : token;
	return <MagicLinkVerifyClient token={value ?? ""} />;
}
