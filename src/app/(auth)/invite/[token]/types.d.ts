export type InviteDetails = {
	email: string;
	name: string;
	organizationName: string;
};

export type AcceptInviteResponse = {
	ok?: boolean;
	email?: string;
	redirect?: string;
	error?: unknown;
};
