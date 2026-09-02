export type AuthActivityAction = "auth.login" | "auth.logout" | "auth.invite_accepted";

export type AuthActivityMetadata = {
	ipAddress: string;
	city: string | null;
	country: string | null;
	device: string;
	platform: string;
	userAgent: string;
};
