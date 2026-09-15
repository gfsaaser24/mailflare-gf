export type DraftPayload = {
	mailboxId?: string | null;
	from?: string;
	to?: string;
	/** One address, several separated by `,`/`;`, or an array. Same shape as send. */
	cc?: string | string[] | null;
	bcc?: string | string[] | null;
	subject?: string;
	text?: string;
	html?: string;
};
