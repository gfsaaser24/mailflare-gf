import { z } from "zod";

/** How long a sign-in link stays usable. Shorter than a reset: it is a login. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export const magicLinkRequestSchema = z.object({
	email: z.string().email().max(320),
});

export const magicLinkConsumeSchema = z.object({
	token: z.string().min(1).max(256),
});
