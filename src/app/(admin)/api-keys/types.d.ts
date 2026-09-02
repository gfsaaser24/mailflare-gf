export type ApiKey = {
	id: string;
	name: string;
	prefix: string;
	scopes: string;
	createdAt?: string;
	expiresAt?: string | null;
	revokedAt?: string | null;
	lastUsedAt?: string | null;
};
