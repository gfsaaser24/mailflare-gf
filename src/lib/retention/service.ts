/**
 * Storage reclaim and retention (T5.2).
 *
 * Two things live here:
 *
 * 1. `deleteMessagesPermanently()` — the ONE way a message is really deleted.
 *    It removes the raw object, every attachment object, the rows (attachment
 *    rows cascade from `messages`) and gives the bytes back to
 *    `org_usage.storage_bytes`. Every caller that used to delete message rows
 *    by hand goes through it: the message routes, the bulk route and
 *    `deleteMailbox()`.
 *
 * 2. `runRetention()` — the daily sweep (`scripts/retention.ts`). For each
 *    organisation it applies that organisation's windows (`./settings.ts`) to
 *    trashed messages, expired sessions, webhook deliveries, auto-reply
 *    records, outbound jobs, audit logs and resolved inbound failures.
 *
 * Rules that must not be lost:
 * - storage is best effort, the database is not: an object that cannot be
 *   deleted is logged and the rows still go, otherwise a broken bucket would
 *   pin every trashed message forever;
 * - bytes are measured BEFORE anything is removed, so the decrement matches
 *   what inbound booked;
 * - `platform.*` audit actions are never deleted, whatever `audit_logs_days`
 *   says: they are the cross-tenant operator trail.
 */
import { and, eq, inArray, isNotNull, lt, not, like, sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import {
	auditLogs,
	autoReplyDeliveries,
	inboundFailures,
	mailboxes,
	messages,
	organizations,
	outboundJobs,
	sessions,
	users,
	webhookDeliveries,
	webhooks,
} from "@/db/schema";
import { deleteAttachmentsForMessages, sumAttachmentBytesForMessages } from "@/lib/email/attachments";
import { releaseStorageBytes } from "@/lib/quotas/service";
import {
	cutoffFor,
	getRetention,
	RESOLVED_INBOUND_FAILURE_DAYS,
	type RetentionSettings,
} from "./settings";

/** Chunk size for `IN (...)` lookups so we never build an unbounded statement. */
const MESSAGE_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

export type PermanentDeleteCounts = {
	/** Message rows removed. */
	messages: number;
	/** Storage objects removed (raw messages + attachments). */
	objects: number;
	/** Bytes given back to `org_usage.storage_bytes`. */
	bytes: number;
};

const NO_DELETIONS: PermanentDeleteCounts = { messages: 0, objects: 0, bytes: 0 };

/** Total stored size of the given objects; a missing or unreadable object counts as 0. */
async function sumObjectBytes(env: CloudflareEnv, keys: string[]): Promise<number> {
	let total = 0;
	for (const key of keys) {
		try {
			const head = await env.BUCKET.head(key);
			total += head?.size ?? 0;
		} catch (error) {
			console.error("retention: storage head failed", key, error);
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
			console.error("retention: storage delete failed", key, error);
		}
	}
	return deleted;
}

/**
 * Deletes messages for good: objects first, then rows, then the usage refund.
 *
 * `organizationId` is both the scope of the lookup (a message in another
 * organisation is silently ignored, exactly as if it did not exist) and the
 * organisation whose `storage_bytes` gets the refund.
 */
export async function deleteMessagesPermanently(
	env: CloudflareEnv,
	organizationId: string,
	messageIds: string[],
): Promise<PermanentDeleteCounts> {
	const ids = [...new Set(messageIds.filter(Boolean))];
	if (ids.length === 0) return { ...NO_DELETIONS };
	const db = getDb(env);

	const rows: Array<{ id: string; rawR2Key: string | null }> = [];
	for (const batch of chunk(ids, MESSAGE_CHUNK)) {
		const found = await db
			.select({ id: messages.id, rawR2Key: messages.rawR2Key })
			.from(messages)
			.where(and(eq(messages.organizationId, organizationId), inArray(messages.id, batch)));
		rows.push(...found);
	}
	if (rows.length === 0) return { ...NO_DELETIONS };

	const found = rows.map((row) => row.id);
	// Measured before anything is removed, so the refund matches what was booked.
	const attachmentBytes = await sumAttachmentBytesForMessages(env, found);
	const attachmentResult = await deleteAttachmentsForMessages(env, found);
	const rawKeys = rows.map((row) => row.rawR2Key).filter((key): key is string => !!key);
	const rawBytes = await sumObjectBytes(env, rawKeys);
	const objects = attachmentResult.deleted + (await deleteObjects(env, rawKeys));

	let deleted = 0;
	for (const batch of chunk(found, MESSAGE_CHUNK)) {
		// `message_attachments` cascade; `audit_logs.message_id` is ON DELETE SET NULL.
		const removed = await db
			.delete(messages)
			.where(and(eq(messages.organizationId, organizationId), inArray(messages.id, batch)))
			.returning({ id: messages.id });
		deleted += removed.length;
	}

	const bytes = attachmentBytes + rawBytes;
	await releaseStorageBytes(db, organizationId, bytes);

	return { messages: deleted, objects, bytes };
}

export type RetentionCounts = {
	/** Trashed messages deleted for good. */
	messages: number;
	/** Storage objects those messages owned. */
	objects: number;
	/** Bytes returned to `org_usage.storage_bytes`. */
	bytes: number;
	sessions: number;
	webhookDeliveries: number;
	autoReplyDeliveries: number;
	outboundJobs: number;
	auditLogs: number;
	inboundFailures: number;
};

export type OrganizationRetentionResult = RetentionCounts & {
	organizationId: string;
	settings: RetentionSettings;
};

const ZERO_COUNTS: RetentionCounts = {
	messages: 0,
	objects: 0,
	bytes: 0,
	sessions: 0,
	webhookDeliveries: 0,
	autoReplyDeliveries: 0,
	outboundJobs: 0,
	auditLogs: 0,
	inboundFailures: 0,
};

/**
 * Trashed messages past the window, through the one delete path.
 *
 * The window is time spent IN the trash (`trashed_at`), not the age of the
 * message: something old that was trashed today must survive.
 */
async function sweepTrashedMessages(
	env: CloudflareEnv,
	db: AppDatabase,
	organizationId: string,
	cutoff: Date,
): Promise<PermanentDeleteCounts> {
	const stale = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.organizationId, organizationId),
				eq(messages.status, "trash"),
				isNotNull(messages.trashedAt),
				lt(messages.trashedAt, cutoff),
			),
		);
	if (stale.length === 0) return { ...NO_DELETIONS };
	return deleteMessagesPermanently(
		env,
		organizationId,
		stale.map((row) => row.id),
	);
}

/**
 * Applies one organisation's windows. Anything that fails is thrown to the
 * caller, which records it per organisation and carries on with the next one.
 */
export async function runRetentionForOrganization(
	env: CloudflareEnv,
	organizationId: string,
	options?: { now?: Date },
): Promise<OrganizationRetentionResult> {
	const db = getDb(env);
	const now = options?.now ?? new Date();
	const settings = await getRetention(db, organizationId);
	const counts: RetentionCounts = { ...ZERO_COUNTS };

	const trashed = await sweepTrashedMessages(
		env,
		db,
		organizationId,
		cutoffFor(settings.trashDays, now),
	);
	counts.messages = trashed.messages;
	counts.objects = trashed.objects;
	counts.bytes = trashed.bytes;

	// `sessions` has no organization_id: scope it through its user.
	const orgUserIds = db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.organizationId, organizationId));
	counts.sessions = (
		await db
			.delete(sessions)
			.where(
				and(
					inArray(sessions.userId, orgUserIds),
					lt(sessions.expiresAt, cutoffFor(settings.sessionsDays, now)),
				),
			)
			.returning({ id: sessions.id })
	).length;

	// `webhook_deliveries` has no organization_id: scope it through its webhook.
	const orgWebhookIds = db
		.select({ id: webhooks.id })
		.from(webhooks)
		.where(eq(webhooks.organizationId, organizationId));
	counts.webhookDeliveries = (
		await db
			.delete(webhookDeliveries)
			.where(
				and(
					inArray(webhookDeliveries.webhookId, orgWebhookIds),
					lt(webhookDeliveries.createdAt, cutoffFor(settings.webhookDeliveriesDays, now)),
				),
			)
			.returning({ id: webhookDeliveries.id })
	).length;

	// `auto_reply_deliveries` has no organization_id: scope it through its mailbox.
	const orgMailboxIds = db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(eq(mailboxes.organizationId, organizationId));
	counts.autoReplyDeliveries = (
		await db
			.delete(autoReplyDeliveries)
			.where(
				and(
					inArray(autoReplyDeliveries.mailboxId, orgMailboxIds),
					lt(autoReplyDeliveries.sentAt, cutoffFor(settings.autoReplyDays, now)),
				),
			)
			.returning({ id: autoReplyDeliveries.id })
	).length;

	// `outbound_jobs` has no organization_id: scope it through its user.
	counts.outboundJobs = (
		await db
			.delete(outboundJobs)
			.where(
				and(
					inArray(outboundJobs.userId, orgUserIds),
					lt(outboundJobs.createdAt, cutoffFor(settings.outboundJobsDays, now)),
				),
			)
			.returning({ id: outboundJobs.id })
	).length;

	// `platform.*` is the cross-tenant operator trail: it is never deleted.
	counts.auditLogs = (
		await db
			.delete(auditLogs)
			.where(
				and(
					eq(auditLogs.organizationId, organizationId),
					lt(auditLogs.createdAt, cutoffFor(settings.auditLogsDays, now)),
					not(like(auditLogs.action, "platform.%")),
				),
			)
			.returning({ id: auditLogs.id })
	).length;

	// Only failures somebody already dealt with; unresolved ones are kept.
	counts.inboundFailures = (
		await db
			.delete(inboundFailures)
			.where(
				and(
					eq(inboundFailures.organizationId, organizationId),
					isNotNull(inboundFailures.resolvedAt),
					lt(inboundFailures.resolvedAt, cutoffFor(RESOLVED_INBOUND_FAILURE_DAYS, now)),
				),
			)
			.returning({ id: inboundFailures.id })
	).length;

	return { organizationId, settings, ...counts };
}

export type RetentionRunResult = {
	results: OrganizationRetentionResult[];
	failures: Array<{ organizationId: string; error: string }>;
};

/**
 * Runs the sweep for every organisation. One organisation failing never stops
 * the others; the failure is reported so the script can exit non-zero.
 */
export async function runRetention(
	env: CloudflareEnv,
	options?: { now?: Date },
): Promise<RetentionRunResult> {
	const db = getDb(env);
	const orgs = await db
		.select({ id: organizations.id })
		.from(organizations)
		.orderBy(sql`"organizations"."id"`);

	const results: OrganizationRetentionResult[] = [];
	const failures: Array<{ organizationId: string; error: string }> = [];

	for (const org of orgs) {
		try {
			results.push(await runRetentionForOrganization(env, org.id, options));
		} catch (error) {
			failures.push({
				organizationId: org.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { results, failures };
}

export { DEFAULT_RETENTION, getRetention, setRetention, parseRetentionInput } from "./settings";
export type { RetentionSettings } from "./settings";
