import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { MAX_RECIPIENTS, joinRecipients, normalizeRecipients } from "@/lib/email/recipients";
import type { DraftPayload } from "./types";

export async function getDraftSender(
	env: CloudflareEnv,
	userId: string,
	orgId: string,
	input: DraftPayload,
): Promise<{ fromAddr: string; mailboxId: string } | { error: string }> {
	try {
		return await getAuthorizedSenderAddress(env, {
			userId,
			from: input.from ?? "",
			mailboxId: input.mailboxId,
			organizationId: orgId,
		});
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Mailbox is not authorized" };
	}
}

export function userOwnsDraft(draft: { userId: string; status: string } | undefined, userId: string): boolean {
	return !!draft && draft.userId === userId && draft.status === "draft";
}

/**
 * A draft's recipient lists, normalised exactly as a send normalises them
 * (`src/lib/email/recipients.ts`).
 *
 * `to` keeps what the composer typed: a draft is half-written by definition and
 * autosave must not rewrite the field under the cursor. `cc` and `bcc` are
 * stored comma-joined, the same shape `sendEmail` writes, so a reopened draft
 * hands them straight back to the form. The 50-recipient ceiling is the
 * envelope one — `to` + `cc` + `bcc` together, not per field.
 */
export function getDraftRecipients(
	input: DraftPayload,
): { toAddr: string; ccAddr: string | null; bccAddr: string | null } | { error: string } {
	const toAddresses = normalizeRecipients(input.to);
	const ccAddresses = normalizeRecipients(input.cc);
	const bccAddresses = normalizeRecipients(input.bcc);
	if (toAddresses.length + ccAddresses.length + bccAddresses.length > MAX_RECIPIENTS) {
		return { error: `A message can have at most ${MAX_RECIPIENTS} recipients in total` };
	}
	return {
		toAddr: input.to ?? "",
		ccAddr: joinRecipients(ccAddresses),
		bccAddr: joinRecipients(bccAddresses),
	};
}
