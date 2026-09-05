import { and, eq } from "drizzle-orm";
import { domains, mailboxes } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import type { MailboxUpdateValues } from "./types";

/** One mailbox of the request's organisation, joined to its domain. */
export function selectMailboxForOrg({ db, scoped }: OrgContext, mailboxId: string) {
	return db
		.select({
			id: mailboxes.id,
			userId: mailboxes.userId,
			domainId: mailboxes.domainId,
		localPart: mailboxes.localPart,
		displayName: mailboxes.displayName,
		signature: mailboxes.signature,
		autoReplyEnabled: mailboxes.autoReplyEnabled,
		autoReplySubject: mailboxes.autoReplySubject,
		autoReplyBody: mailboxes.autoReplyBody,
		useAllDomains: mailboxes.useAllDomains,
			avatarKey: mailboxes.avatarKey,
			type: mailboxes.type,
			agentMail: mailboxes.agentMail,
			disabled: mailboxes.disabled,
			createdAt: mailboxes.createdAt,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(scoped(mailboxes), eq(mailboxes.id, mailboxId)))
		.limit(1);
}

export function getMailboxUpdateValues(input: MailboxUpdateValues): MailboxUpdateValues {
	const values: MailboxUpdateValues = {};
	if ("displayName" in input) values.displayName = input.displayName?.trim() || null;
	if ("signature" in input) values.signature = input.signature?.trim() || null;
	if ("autoReplyEnabled" in input) values.autoReplyEnabled = input.autoReplyEnabled;
	if ("autoReplySubject" in input) values.autoReplySubject = input.autoReplySubject?.trim() || "Out of office";
	if ("autoReplyBody" in input) values.autoReplyBody = input.autoReplyBody?.trim() || "";
	if ("useAllDomains" in input) values.useAllDomains = input.useAllDomains;
	if ("agentMail" in input) values.agentMail = input.agentMail;
	return values;
}
