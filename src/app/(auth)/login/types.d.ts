export type LoginResult = {
	ok?: boolean;
	redirect?: string;
	/** Password accepted, TOTP still outstanding: the session is only pending. */
	requiresTwoFactor?: boolean;
	error?: string;
};
