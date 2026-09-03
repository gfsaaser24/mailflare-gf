export type AuthActivityAction =
	| "auth.login"
	| "auth.logout"
	| "auth.invite_accepted"
	| "auth.password_reset_requested"
	| "auth.password_reset"
	| "auth.password_changed"
	| "auth.magic_link_requested"
	| "auth.two_factor_enabled"
	| "auth.two_factor_disabled"
	| "auth.two_factor_backup_codes_regenerated"
	| "auth.sessions_revoked";

export type AuthActivityMetadata = {
	ipAddress: string;
	city: string | null;
	country: string | null;
	device: string;
	platform: string;
	userAgent: string;
};
