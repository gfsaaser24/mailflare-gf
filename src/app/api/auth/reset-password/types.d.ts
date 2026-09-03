/** `POST /api/auth/reset-password`. */
export type ResetPasswordResponse = {
	ok?: boolean;
	redirect?: string;
	error?: string;
	/** Set when the link itself is unknown, spent or expired. */
	invalidToken?: boolean;
};
