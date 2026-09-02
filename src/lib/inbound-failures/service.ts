import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { inboundFailures } from "@/db/schema";
import { processInboundMessage } from "@/lib/email/inbound";
import { newId } from "@/lib/ids";

export type InboundFailureInput = {
	rawR2Key: string;
	mailboxId: string | null;
	fromAddr: string;
	toAddr: string;
	error: unknown;
};

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Records a message that was stored raw but could not be processed. Keyed by the raw
 * object so a retried delivery of the same object bumps `attempts` instead of piling up.
 */
export async function recordInboundFailure(env: CloudflareEnv, input: InboundFailureInput): Promise<string> {
	const db = getDb(env);
	const [row] = await db
		.insert(inboundFailures)
		.values({
			id: newId("inf"),
			rawR2Key: input.rawR2Key,
			mailboxId: input.mailboxId,
			fromAddr: input.fromAddr,
			toAddr: input.toAddr,
			error: toErrorMessage(input.error),
			attempts: 1,
		})
		.onConflictDoUpdate({
			target: inboundFailures.rawR2Key,
			set: {
				attempts: sql`${inboundFailures.attempts} + 1`,
				error: toErrorMessage(input.error),
				resolvedAt: null,
			},
		})
		.returning({ id: inboundFailures.id });
	return row.id;
}

export async function listInboundFailures(env: CloudflareEnv, options?: { includeResolved?: boolean }) {
	const db = getDb(env);
	const query = db.select().from(inboundFailures);
	const rows = options?.includeResolved
		? await query.orderBy(desc(inboundFailures.createdAt)).limit(200)
		: await query
				.where(isNull(inboundFailures.resolvedAt))
				.orderBy(desc(inboundFailures.createdAt))
				.limit(200);
	return rows;
}

export async function getInboundFailure(env: CloudflareEnv, id: string) {
	const db = getDb(env);
	const [row] = await db.select().from(inboundFailures).where(eq(inboundFailures.id, id)).limit(1);
	return row ?? null;
}

export type RetryResult =
	| { status: "not_found" }
	| { status: "resolved"; id: string }
	| { status: "failed"; id: string; error: string };

/** Re-runs processing from the stored raw object. Clears the row on success. */
export async function retryInboundFailure(env: CloudflareEnv, id: string): Promise<RetryResult> {
	const db = getDb(env);
	const failure = await getInboundFailure(env, id);
	if (!failure) return { status: "not_found" };
	if (failure.resolvedAt) return { status: "resolved", id: failure.id };

	try {
		const raw = await env.BUCKET.get(failure.rawR2Key);
		if (!raw) throw new Error(`Raw message ${failure.rawR2Key} is no longer in storage`);
		await processInboundMessage(env, {
			from: failure.fromAddr,
			to: failure.toAddr,
			rawR2Key: failure.rawR2Key,
		});
	} catch (error) {
		const message = toErrorMessage(error);
		await db
			.update(inboundFailures)
			.set({
				attempts: sql`${inboundFailures.attempts} + 1`,
				error: message,
			})
			.where(eq(inboundFailures.id, failure.id));
		return { status: "failed", id: failure.id, error: message };
	}

	await db
		.update(inboundFailures)
		.set({
			attempts: sql`${inboundFailures.attempts} + 1`,
			error: null,
			nextAttemptAt: null,
			resolvedAt: new Date(),
		})
		.where(and(eq(inboundFailures.id, failure.id), isNull(inboundFailures.resolvedAt)));
	return { status: "resolved", id: failure.id };
}
