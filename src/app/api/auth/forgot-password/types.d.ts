/** `POST /api/auth/forgot-password`. Always the same body, whoever asked. */
export type ForgotPasswordResponse = {
	ok?: boolean;
	error?: unknown;
};
