export type Mailbox = {
	id: string;
	localPart: string;
	displayName: string | null;
	hasAvatar?: boolean;
	domainId: string;
	hostname: string;
	type?: "personal" | "shared";
	permission?: "read_only" | "send_as" | "send_on_behalf" | "full_access";
	isPrimary?: boolean;
	disabled?: boolean;
	/** The inbox is operated by an automated agent (see `src/lib/mailboxes/agent-mail.ts`). */
	agentMail?: boolean;
	/** Set by `GET /api/mailboxes?scope=organization` only. */
	ownerUserId?: string;
	ownerEmail?: string;
	ownerName?: string;
	/** True when the caller owns the mailbox and may manage it inline. */
	isOwn?: boolean;
};

export type Domain = {
	id: string;
	hostname: string;
};

export type CurrentAccountResponse = {
	user?: {
		id?: string;
		email?: string;
		name?: string | null;
	};
};

export type MailboxOwner = {
	id: string;
	email: string;
	name: string;
	role: "admin" | "user";
};

export type MailboxesResponse = {
	mailboxes: Mailbox[];
	canCreateShared: boolean;
};
