/**
 * Quota templates (T5.1).
 *
 * A limit of `null` means "unlimited" for that dimension; the `unlimited`
 * template is every limit `null`, so no check ever runs for it.
 */

export const QUOTA_TEMPLATE_NAMES = ["small", "standard", "unlimited"] as const;
export type QuotaTemplate = (typeof QUOTA_TEMPLATE_NAMES)[number];

/** The seven limits `org_quotas` stores, in application shape. */
export type QuotaLimits = {
	maxMailboxes: number | null;
	maxSharedMailboxes: number | null;
	maxAccounts: number | null;
	maxDomains: number | null;
	maxStorageBytes: number | null;
	maxDailySends: number | null;
	maxAttachmentBytes: number | null;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** What an organisation with no `org_quotas` row gets: no limits at all. */
export const UNLIMITED_QUOTA: QuotaLimits = {
	maxMailboxes: null,
	maxSharedMailboxes: null,
	maxAccounts: null,
	maxDomains: null,
	maxStorageBytes: null,
	maxDailySends: null,
	maxAttachmentBytes: null,
};

export const QUOTA_TEMPLATE_LIMITS: Record<QuotaTemplate, QuotaLimits> = {
	small: {
		maxMailboxes: 5,
		maxSharedMailboxes: 1,
		maxAccounts: 3,
		maxDomains: 1,
		maxStorageBytes: GIB,
		maxDailySends: 200,
		maxAttachmentBytes: 10 * MIB,
	},
	standard: {
		maxMailboxes: 25,
		maxSharedMailboxes: 5,
		maxAccounts: 15,
		maxDomains: 5,
		maxStorageBytes: 10 * GIB,
		maxDailySends: 2000,
		maxAttachmentBytes: 25 * MIB,
	},
	unlimited: { ...UNLIMITED_QUOTA },
};

export function quotaTemplateLimits(template: QuotaTemplate): QuotaLimits {
	return { ...QUOTA_TEMPLATE_LIMITS[template] };
}

export function isQuotaTemplate(value: unknown): value is QuotaTemplate {
	return (
		typeof value === "string" && (QUOTA_TEMPLATE_NAMES as readonly string[]).includes(value)
	);
}
