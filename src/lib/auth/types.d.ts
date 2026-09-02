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
	/**
	 * Platform operator acting as this user, when the session was minted by
	 * `/api/platform/orgs/[id]/impersonate` (T3.3). Absent or null otherwise.
	 */
	impersonatedByUserId?: string | null;
};
