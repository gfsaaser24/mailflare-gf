export type MagicLinkConsumeResult = {
	ok: boolean;
	/** Where to go next. `completeLogin()` sends TOTP users to the code prompt. */
	redirect?: string;
	error?: string;
	/** True when the link is unknown, already spent or expired. */
	invalidToken?: boolean;
};
