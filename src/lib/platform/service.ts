/**
 * Platform-plane data access (T3.3).
 *
 * Everything here reads or writes **across** organisations on purpose, so it is
 * only ever reachable from `/api/platform/**` behind `requirePlatformOperator()`
 * (`src/lib/platform/guard.ts`). Nothing in this file may be imported by a
 * tenant route.
 */
import { and, asc, count, eq, gte, ilike, or, sql, sum } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import {
	auditLogs,
	domains,
	mailboxes,
	messageAttachments,
	messages,
	organizations,
	users,
} from "@/db/schema";
import { createInvite, generateRandomPassword } from "@/lib/accounts/service";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { newId } from "@/lib/ids";
import {
	applyQuotaTemplate,
	ensureUsageRow,
	getOrganizationQuota,
	setOrganizationQuota as writeOrganizationQuota,
} from "@/lib/quotas/service";
import {
	QUOTA_TEMPLATE_NAMES,
	quotaTemplateLimits,
	type QuotaLimits,
	type QuotaTemplate as QuotaTemplateName,
} from "@/lib/quotas/templates";

/**
 * Quota templates (T5.1). The names live with the limits in
 * `src/lib/quotas/templates.ts`; a template chosen here is written into
 * `org_quotas` by `createOrganizationWithAdmin` and recorded on the
 * `platform.org_created` audit row.
 */
export const QUOTA_TEMPLATES = QUOTA_TEMPLATE_NAMES;
export type QuotaTemplate = QuotaTemplateName;

/** How long an impersonation session lives. */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

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
	createdAt: Date;
	counts: OrganizationCounts;
};

const ZERO_COUNTS: OrganizationCounts = {
	mailboxes: 0,
	accounts: 0,
	domains: 0,
	storageBytes: 0,
	sendsToday: 0,
};

/** Midnight UTC of the current day; the boundary for "sends today". */
export function startOfUtcDay(now: Date = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every organisation with its live counts.
 *
 * Five small grouped aggregates merged in memory: cheaper to read (and to
 * change) than one query with five correlated sub-selects.
 */
export async function listOrganizationsWithCounts(db: AppDatabase): Promise<OrganizationSummary[]> {
	const orgs = await db.select().from(organizations).orderBy(asc(organizations.createdAt));

	const [mailboxRows, accountRows, domainRows, storageRows, sendRows] = await Promise.all([
		db
			.select({ organizationId: mailboxes.organizationId, value: count() })
			.from(mailboxes)
			.groupBy(mailboxes.organizationId),
		db
			.select({ organizationId: users.organizationId, value: count() })
			.from(users)
			.groupBy(users.organizationId),
		db
			.select({ organizationId: domains.organizationId, value: count() })
			.from(domains)
			.groupBy(domains.organizationId),
		db
			.select({ organizationId: messages.organizationId, value: sum(messageAttachments.size) })
			.from(messageAttachments)
			.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
			.groupBy(messages.organizationId),
		db
			.select({ organizationId: messages.organizationId, value: count() })
			.from(messages)
			.where(and(eq(messages.direction, "outbound"), gte(messages.createdAt, startOfUtcDay())))
			.groupBy(messages.organizationId),
	]);

	const index = new Map<string, OrganizationCounts>();
	const merge = (
		rows: Array<{ organizationId: string; value: unknown }>,
		key: keyof OrganizationCounts,
	) => {
		for (const row of rows) {
			const entry = index.get(row.organizationId) ?? { ...ZERO_COUNTS };
			entry[key] = toNumber(row.value);
			index.set(row.organizationId, entry);
		}
	};
	merge(mailboxRows, "mailboxes");
	merge(accountRows, "accounts");
	merge(domainRows, "domains");
	merge(storageRows, "storageBytes");
	merge(sendRows, "sendsToday");

	return orgs.map((org) => ({
		id: org.id,
		name: org.name,
		slug: org.slug,
		status: org.status,
		notes: org.notes,
		createdAt: org.createdAt,
		counts: index.get(org.id) ?? { ...ZERO_COUNTS },
	}));
}

/** One organisation with its counts, or `null` when it does not exist. */
export async function getOrganizationSummary(
	db: AppDatabase,
	organizationId: string,
): Promise<OrganizationSummary | null> {
	const all = await listOrganizationsWithCounts(db);
	return all.find((org) => org.id === organizationId) ?? null;
}

export type CreateOrganizationInput = {
	name: string;
	slug: string;
	adminEmail: string;
	adminName: string;
	quotaTemplate?: QuotaTemplate;
};

export type CreateOrganizationResult = {
	organization: { id: string; name: string; slug: string; status: "active" | "suspended" };
	admin: { id: string; email: string; name: string };
	/**
	 * The set-password link for the new admin, returned **once** (T3.5).
	 *
	 * A brand-new organisation has no mailbox to send from, so the invite is not
	 * emailed: the operator copies this link and hands it over. It works once and
	 * expires after seven days. No password is ever shown — the account is created
	 * with a random one that nobody is told.
	 */
	inviteUrl: string;
	quotaTemplate: QuotaTemplate | null;
};

export class SlugTakenError extends Error {
	constructor() {
		super("Slug already in use");
		this.name = "SlugTakenError";
	}
}

export class EmailTakenError extends Error {
	constructor() {
		super("Email already in use");
		this.name = "EmailTakenError";
	}
}

/** Creates an organisation plus its first admin user. */
export async function createOrganizationWithAdmin(
	db: AppDatabase,
	input: CreateOrganizationInput,
	operatorUserId: string,
): Promise<CreateOrganizationResult> {
	const name = input.name.trim();
	const adminName = input.adminName.trim();
	const slug = input.slug.trim().toLowerCase();
	const email = input.adminEmail.trim().toLowerCase();

	const [slugTaken] = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.slug, slug))
		.limit(1);
	if (slugTaken) throw new SlugTakenError();

	const [emailTaken] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (emailTaken) throw new EmailTakenError();

	const organizationId = newId("org");
	const adminId = newId("usr");
	// Placeholder only: the admin sets their real password through the invite.
	const placeholderPassword = generateRandomPassword();

	await db.insert(organizations).values({
		id: organizationId,
		name,
		slug,
		status: "active",
	});

	await db.insert(users).values({
		id: adminId,
		organizationId,
		email,
		passwordHash: hashPassword(placeholderPassword),
		name: adminName,
		role: "admin",
		canManageMailboxes: true,
	});

	// Quotas (T5.1): the chosen template becomes the org's limits, and the usage
	// row starts at zero so the first check has something to lock.
	if (input.quotaTemplate) {
		await applyQuotaTemplate(db, organizationId, input.quotaTemplate);
	} else {
		await ensureUsageRow(db, organizationId);
	}

	await db.insert(auditLogs).values({
		id: newId("aud"),
		organizationId,
		actorUserId: operatorUserId,
		targetUserId: adminId,
		action: "platform.org_created",
		metadata: JSON.stringify({
			organizationId,
			slug,
			quotaTemplate: input.quotaTemplate ?? null,
		}),
	});

	const invite = await createInvite(db, {
		organizationId,
		userId: adminId,
		createdByUserId: operatorUserId,
	});

	return {
		organization: { id: organizationId, name, slug, status: "active" },
		admin: { id: adminId, email, name: adminName },
		inviteUrl: invite.url,
		quotaTemplate: input.quotaTemplate ?? null,
	};
}

export type UpdateOrganizationInput = {
	name?: string;
	notes?: string | null;
	status?: "active" | "suspended";
};

/** Renames / re-notes / suspends / restores an organisation. */
export async function updateOrganization(
	db: AppDatabase,
	organizationId: string,
	patch: UpdateOrganizationInput,
	operatorUserId: string,
): Promise<OrganizationSummary | null> {
	const [existing] = await db
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!existing) return null;

	const values: UpdateOrganizationInput = {};
	if (patch.name !== undefined) values.name = patch.name.trim();
	if (patch.notes !== undefined) values.notes = patch.notes;
	if (patch.status !== undefined) values.status = patch.status;

	if (Object.keys(values).length > 0) {
		await db.update(organizations).set(values).where(eq(organizations.id, organizationId));
	}

	if (patch.status !== undefined && patch.status !== existing.status) {
		await db.insert(auditLogs).values({
			id: newId("aud"),
			organizationId,
			actorUserId: operatorUserId,
			action: patch.status === "suspended" ? "platform.org_suspended" : "platform.org_restored",
			metadata: JSON.stringify({ organizationId, status: patch.status }),
		});
	}

	return getOrganizationSummary(db, organizationId);
}

export type OrganizationQuotaPatch = Partial<QuotaLimits> & { template?: QuotaTemplate };

/** The organisation's limits, or `null` when the organisation does not exist. */
export async function getOrganizationQuotaLimits(
	db: AppDatabase,
	organizationId: string,
): Promise<QuotaLimits | null> {
	const [existing] = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!existing) return null;
	return getOrganizationQuota(db, organizationId);
}

/**
 * Sets an organisation's quota: a template, explicit limits, or a template with
 * explicit limits on top. Returns `null` when the organisation does not exist.
 */
export async function setOrganizationQuota(
	db: AppDatabase,
	organizationId: string,
	patch: OrganizationQuotaPatch,
	operatorUserId?: string,
): Promise<QuotaLimits | null> {
	const [existing] = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!existing) return null;

	const { template, ...explicit } = patch;
	const limits = await writeOrganizationQuota(db, organizationId, {
		...(template ? quotaTemplateLimits(template) : {}),
		...explicit,
	});
	await ensureUsageRow(db, organizationId);

	if (operatorUserId) {
		await db.insert(auditLogs).values({
			id: newId("aud"),
			organizationId,
			actorUserId: operatorUserId,
			action: "platform.org_quota_updated",
			metadata: JSON.stringify({ organizationId, template: template ?? null, limits }),
		});
	}

	return limits;
}

export type ImpersonationResult = {
	token: string;
	expiresAt: Date;
	targetUserId: string;
	organizationId: string;
};

export class NoOrganizationAdminError extends Error {
	constructor() {
		super("Organisation has no admin to impersonate");
		this.name = "NoOrganizationAdminError";
	}
}

/**
 * Mints a 1-hour session for the organisation's first admin, flagged with the
 * operator's id, and writes the `platform.impersonate` audit row.
 */
export async function impersonateOrganization(
	env: AppEnv,
	db: AppDatabase,
	organizationId: string,
	operatorUserId: string,
): Promise<ImpersonationResult | null> {
	const [org] = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!org) return null;

	const [target] = await db
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.organizationId, organizationId),
				eq(users.role, "admin"),
				eq(users.disabled, false),
			),
		)
		.orderBy(asc(users.createdAt))
		.limit(1);
	if (!target) throw new NoOrganizationAdminError();

	const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
	const token = await createSession(env, target.id, {
		expiresInMs: IMPERSONATION_TTL_MS,
		impersonatedByUserId: operatorUserId,
		impersonatedOrganizationId: organizationId,
	});

	await db.insert(auditLogs).values({
		id: newId("aud"),
		organizationId,
		actorUserId: operatorUserId,
		targetUserId: target.id,
		action: "platform.impersonate",
		metadata: JSON.stringify({ organizationId, targetUserId: target.id }),
	});

	return { token, expiresAt, targetUserId: target.id, organizationId };
}

export type PlatformSearchHit = {
	organizationId: string;
	type: "mailbox" | "domain";
	id: string;
	label: string;
};

/** Mailbox addresses and domain hostnames across every organisation. */
export async function searchPlatform(
	db: AppDatabase,
	query: string,
	limit = 25,
): Promise<PlatformSearchHit[]> {
	const term = query.trim();
	if (term.length === 0) return [];
	const pattern = `%${term}%`;
	const address = sql<string>`${mailboxes.localPart} || '@' || ${domains.hostname}`;

	const [mailboxHits, domainHits] = await Promise.all([
		db
			.select({
				organizationId: mailboxes.organizationId,
				id: mailboxes.id,
				label: address,
			})
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id))
			.where(or(ilike(mailboxes.localPart, pattern), ilike(address, pattern)))
			.orderBy(asc(mailboxes.localPart))
			.limit(limit),
		db
			.select({
				organizationId: domains.organizationId,
				id: domains.id,
				label: domains.hostname,
			})
			.from(domains)
			.where(ilike(domains.hostname, pattern))
			.orderBy(asc(domains.hostname))
			.limit(limit),
	]);

	return [
		...mailboxHits.map((hit) => ({ ...hit, type: "mailbox" as const })),
		...domainHits.map((hit) => ({ ...hit, type: "domain" as const })),
	];
}
