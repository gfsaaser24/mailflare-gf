export type UserRole = "admin" | "user";

export type SessionUser = {
	id: string;
	/** Organisation the user belongs to. Every tenant query is scoped by it (T3.2). */
	organizationId: string;
	email: string;
	resetEmail: string | null;
	forwardingEmail: string | null;
	passwordHash: string;
	name: string;
	role: UserRole;
	disabled: boolean;
	canManageMailboxes: boolean;
	createdByUserId: string | null;
	createdAt: Date;
};
