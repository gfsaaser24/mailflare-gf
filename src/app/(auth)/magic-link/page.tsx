/**
 * `/magic-link` — asks for a passwordless sign-in link.
 *
 * Rendered dynamically so Next's inline scripts carry the CSP nonce
 * (see `src/lib/security/headers.ts`).
 */
import { MagicLinkClient } from "./magic-link-client";

export const dynamic = "force-dynamic";

export default function MagicLinkPage() {
	return <MagicLinkClient />;
}
