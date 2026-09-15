export type ComposeDraft = {
	id: string;
	mailboxId: string | null;
	fromAddr: string;
	toAddr: string;
	/** Comma-joined `Cc` list, null when the draft has none. */
	ccAddr: string | null;
	/** Comma-joined `Bcc` list, null when the draft has none. */
	bccAddr: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
};

export type DraftResponse = {
	draft?: ComposeDraft;
	error?: string;
};

export type ComposeAttachment = {
	id: string;
	file: File;
};
