import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { domains, mailboxes, messages } from "@/db/schema";
import { deleteEmailRoutingRule, listEmailRoutingRules } from "@/lib/cloudflare-api";
import { deleteAttachmentsForMessages, sumAttachmentBytesForMessages } from "@/lib/email/attachments";
import { getUserOrganizationId } from "@/lib/organizations/service";
import { releaseQuota, releaseStorageBytes } from "@/lib/quotas/service";
import { createAuditLog } from "./audit";

/** Thrown when any Cloudflare call fails; the caller must leave the database untouched. */
export class MailboxCloudflareCleanupError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MailboxCloudflareCleanupError";
	}
}

export type MailboxDeleteInput = {
	id: string;
	userId: string;
	domainId: string;
	localPart: string;
	useAllDomains: boolean;
	avatarKey: string | null;
};

export type MailboxDeleteCounts = {
	/** Email Routing rules removed from Cloudflare. */
	rules: number;
	/** Storage objects removed (raw messages + attachments + avatar). */
	objects: number;
	/** Message rows removed. */
	messages: number;
};

type RoutingTarget = { zoneId: string; address: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Every address this mailbox may hold an Email Routing rule for.
 *
 * Mirrors `ensureMailboxDomainRouting`: the primary domain always counts, and a
 * `useAllDomains` mailbox also owns the same local part on every other domain of the
 * same user, except domains where a different mailbox claims that local part, because
 * such a rule belongs to the other mailbox. Unlike `getMailboxDomainAddresses` this
 * ignores domain status, so rules on a domain that has since gone inactive are still
 * cleaned up.
 */
export async function collectMailboxRoutingTargets(
	db: AppDatabase,
	mailbox: MailboxDeleteInput,
	orgId?: string,
): Promise<RoutingTarget[]> {
	const localPart = mailbox.localPart.toLowerCase();
	const ownerDomains = await db
		.select({ id: domains.id, hostname: domains.hostname, zoneId: domains.zoneId })
		.from(domains)
		.where(
			and(eq(domains.userId, mailbox.userId), ...(orgId ? [eq(domains.organizationId, orgId)] : [])),
		);

	const primary = ownerDomains.find((domain) => domain.id === mailbox.domainId);
	if (!primary) return [];
	const primaryTarget: RoutingTarget = {
		zoneId: primary.zoneId,
		address: `${localPart}@${primary.hostname}`.toLowerCase(),
	};
	if (!mailbox.useAllDomains) return [primaryTarget];

	const claimed = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId })
		.from(mailboxes)
		.where(
			and(
				eq(mailboxes.localPart, mailbox.localPart),
				...(orgId ? [eq(mailboxes.organizationId, orgId)] : []),
			),
		);
	const claimedDomainIds = new Set(
		claimed.filter((row) => row.id !== mailbox.id).map((row) => row.domainId),
	);

	return [
		primaryTarget,
		...ownerDomains
			.filter((domain) => domain.id !== mailbox.domainId && !claimedDomainIds.has(domain.id))
			.map((domain) => ({
				zoneId: domain.zoneId,
				address: `${localPart}@${domain.hostname}`.toLowerCase(),
			})),
	];
}

/**
 * Removes every Email Routing rule that points at one of this mailbox's addresses.
 * Any failure aborts with `MailboxCloudflareCleanupError` so the caller can bail out
 * before touching the database.
 */
async function deleteMailboxRoutingRules(
	env: CloudflareEnv,
	targets: RoutingTarget[],
): Promise<number> {
	const addressesByZone = new Map<string, Set<string>>();
	for (const target of targets) {
		const addresses = addressesByZone.get(target.zoneId) ?? new Set<string>();
		addresses.add(target.address);
		addressesByZone.set(target.zoneId, addresses);
	}

	let deleted = 0;
	for (const [zoneId, addresses] of addressesByZone) {
		let ruleIds: string[];
		try {
			const rules = await listEmailRoutingRules(env, zoneId);
			ruleIds = rules
				.filter((rule) =>
					rule.matchers?.some(
						(matcher) =>
							matcher.type === "literal" &&
							matcher.field === "to" &&
							!!matcher.value &&
							addresses.has(matcher.value.toLowerCase()),
					),
				)
				.map((rule) => rule.id ?? rule.tag)
				.filter((ruleId): ruleId is string => !!ruleId);
		} catch (error) {
			throw new MailboxCloudflareCleanupError(
				`could not list Email Routing rules for zone ${zoneId}: ${errorMessage(error)}`,
				{ cause: error },
			);
		}

		for (const ruleId of ruleIds) {
			try {
				await deleteEmailRoutingRule(env, zoneId, ruleId);
				deleted += 1;
			} catch (error) {
				throw new MailboxCloudflareCleanupError(
					`could not delete Email Routing rule ${ruleId} on zone ${zoneId}: ${errorMessage(error)}`,
					{ cause: error },
				);
			}
		}
	}

	return deleted;
}

/** Total stored size of the given objects; a missing or unreadable object counts as 0. */
async function sumObjectBytes(env: CloudflareEnv, keys: string[]): Promise<number> {
	let total = 0;
	for (const key of keys) {
		try {
			const head = await env.BUCKET.head(key);
			total += head?.size ?? 0;
		} catch (error) {
			console.error("deleteMailbox: storage head failed", key, error);
		}
	}
	return total;
}

/** Best-effort object removal; storage problems are logged, never fatal. */
async function deleteObjects(env: CloudflareEnv, keys: string[]): Promise<number> {
	let deleted = 0;
	for (const key of keys) {
		try {
			await env.BUCKET.delete(key);
			deleted += 1;
		} catch (error) {
			console.error("deleteMailbox: storage delete failed", key, error);
		}
	}
	return deleted;
}

/**
 * Deletes a mailbox everywhere: Cloudflare Email Routing rules first (a failure there
 * aborts and leaves the database untouched), then its stored objects, then its rows.
 */
export async function deleteMailbox(
	env: CloudflareEnv,
	db: AppDatabase,
	mailbox: MailboxDeleteInput,
	/** `orgId` is the caller's organisation (`ctx.orgId`); every query is kept inside it. */
	options?: { actorUserId?: string | null; orgId?: string },
): Promise<MailboxDeleteCounts> {
	const orgId = options?.orgId;
	const inOrgMessages = orgId ? [eq(messages.organizationId, orgId)] : [];
	const inOrgMailboxes = orgId ? [eq(mailboxes.organizationId, orgId)] : [];
	const targets = await collectMailboxRoutingTargets(db, mailbox, orgId);
	const rules = await deleteMailboxRoutingRules(env, targets);

	const mailboxMessages = await db
		.select({ id: messages.id, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailbox.id), ...inOrgMessages));
	const messageIds = mailboxMessages.map((message) => message.id);

	// Quota (T5.1): the bytes are measured before anything is removed, so the
	// decrement below matches what inbound booked.
	const attachmentBytes = await sumAttachmentBytesForMessages(env, messageIds);
	const attachmentResult = await deleteAttachmentsForMessages(env, messageIds);
	const rawKeys = mailboxMessages
		.map((message) => message.rawR2Key)
		.filter((key): key is string => !!key);
	const rawBytes = await sumObjectBytes(env, rawKeys);
	const avatarKeys = mailbox.avatarKey ? [mailbox.avatarKey] : [];
	const objects =
		attachmentResult.deleted + (await deleteObjects(env, [...rawKeys, ...avatarKeys]));

	await db.transaction(async (tx) => {
		// messages.mailbox_id is ON DELETE SET NULL, so those rows must go explicitly.
		// message_attachments cascade from messages.
		await tx.delete(messages).where(and(eq(messages.mailboxId, mailbox.id), ...inOrgMessages));
		await tx.delete(mailboxes).where(and(eq(mailboxes.id, mailbox.id), ...inOrgMailboxes));
	});

	const usageOrgId = orgId ?? (await getUserOrganizationId(db, mailbox.userId));
	await releaseStorageBytes(db, usageOrgId, attachmentBytes + rawBytes);
	await releaseQuota(db, usageOrgId, { mailboxes: 1 });

	const counts: MailboxDeleteCounts = { rules, objects, messages: messageIds.length };
	await createAuditLog(env, {
		actorUserId: options?.actorUserId ?? null,
		targetUserId: mailbox.userId,
		// The mailbox row is gone, so it cannot be referenced; keep the id in metadata.
		mailboxId: null,
		action: "mailbox.delete",
		metadata: {
			mailboxId: mailbox.id,
			addresses: targets.map((target) => target.address),
			...counts,
		},
	});

	return counts;
}
