export type Domain = {
	id: string;
	hostname: string;
};

export type Account = {
	id: string;
	email: string;
	name: string;
	resetEmail: string | null;
	role: "admin" | "user";
	disabled?: boolean;
	hasAvatar?: boolean;
	canManageMailboxes?: boolean;
	createdAt: string;
	mailboxId?: string | null;
	localPart?: string | null;
	hostname?: string | null;
};

export type AccountResponse = {
	accounts?: Account[];
	account?: Account;
	/** T3.5: true when the set-password invite was emailed. */
	inviteSent?: boolean;
	/** Only when the invite could **not** be emailed; the admin passes it on. */
	inviteUrl?: string;
	inviteMessage?: string;
	error?: string;
};
