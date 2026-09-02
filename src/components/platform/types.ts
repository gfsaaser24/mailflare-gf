/** Shapes returned by `/api/platform/**` (T3.3), as consumed by the console. */

export type OrganizationCounts = {
	mailboxes: number;
	accounts: number;
	domains: number;
	storageBytes: number;
	sendsToday: number;
};

export type OrganizationSummary = {
	id: string;
	name: string;
	slug: string;
	status: "active" | "suspended";
	notes: string | null;
	createdAt: string;
	counts: OrganizationCounts;
};

export type PlatformSearchHit = {
	organizationId: string;
	type: "mailbox" | "domain";
	id: string;
	label: string;
};

export const QUOTA_TEMPLATES = ["small", "standard", "unlimited"] as const;
export type QuotaTemplate = (typeof QUOTA_TEMPLATES)[number];

export type CreateOrganizationResponse = {
	organization: { id: string; name: string; slug: string; status: "active" | "suspended" };
	admin: { id: string; email: string; name: string };
	temporaryPassword: string;
	quotaTemplate: QuotaTemplate | null;
	passwordDeliveryNote?: string;
};

/** The subset of `/api/auth/me` the platform console cares about. */
export type AuthMeResponse = {
	user?: {
		id: string;
		name: string;
		email: string;
		role: string;
		impersonatedByUserId?: string | null;
		isPlatformOperator?: boolean;
	};
};
