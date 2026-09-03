/** `POST /api/auth/magic-link`. Always the same body, whoever asked. */
export type MagicLinkResponse = {
	ok?: boolean;
	error?: unknown;
};

/** `POST /api/auth/magic-link/consume` — the shape `completeLogin()` returns. */
export type MagicLinkConsumeResponse = {
	ok?: boolean;
	redirect?: string;
	requiresTwoFactor?: boolean;
	error?: string;
};
