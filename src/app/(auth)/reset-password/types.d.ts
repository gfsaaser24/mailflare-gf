export type ResetPasswordResult = {
	ok: boolean;
	redirect?: string;
	error?: string;
	/** True when the link is unknown, already spent or expired. */
	invalidToken?: boolean;
};
