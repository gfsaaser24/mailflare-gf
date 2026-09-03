export type RecoveryRequestResult = {
	ok: boolean;
	/** Present only when the request itself was refused (bad input, throttle). */
	error?: string;
};
