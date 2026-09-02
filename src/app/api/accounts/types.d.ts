export type AccountListItem = {
	id: string;
	email: string;
	name: string;
	resetEmail: string | null;
	role: "admin" | "user";
	createdAt: Date;
	hasAvatar?: boolean;
	canManageMailboxes?: boolean;
	mailboxId: string | null;
	localPart: string | null;
	hostname: string | null;
};

export type CreateAccountResult = {
	id?: string;
	email?: string;
	mailboxId?: string;
	error?: unknown;
};

export type CreateUserAccountInput = {
	username: string;
	domainId: string;
	/** Absent when `sendInvite` is set: the invited user picks their own. */
	password?: string;
	role: "admin" | "user";
	/** Email a set-password invite instead of using `password` (T3.5). */
	sendInvite: boolean;
};

export type AccountListResponse = {
	accounts?: AccountListItem[];
	error?: string;
};
