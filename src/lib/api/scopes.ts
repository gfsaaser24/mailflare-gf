/**
 * The API-key scope catalogue (T6.1).
 *
 * This is the single source of truth: `POST /api/api-keys` rejects anything
 * that is not listed here, the admin UI renders one checkbox per entry, and
 * `withOrg({ requiredScope })` on a `/api/v1/**` route must name one of these.
 *
 * `*` is deliberately not in the catalogue. Cookie sessions get it implicitly
 * (see `with-org.ts`); no issued key may hold it.
 */
export type ScopeName =
	| "messages:read"
	| "messages:write"
	| "conversations:read"
	| "conversations:write"
	| "contacts:read"
	| "send";

export type ScopeDefinition = {
	name: ScopeName;
	description: string;
};

export const SCOPES: readonly ScopeDefinition[] = [
	{ name: "messages:read", description: "Read messages and their attachments" },
	{ name: "messages:write", description: "Update messages (read, star, status, snooze)" },
	{ name: "conversations:read", description: "Read conversations and notes" },
	{ name: "conversations:write", description: "Reply, assign, and add notes to conversations" },
	{ name: "contacts:read", description: "Read contacts" },
	{ name: "send", description: "Send email" },
] as const;

export const SCOPE_NAMES: readonly ScopeName[] = SCOPES.map((scope) => scope.name);

export function isScopeName(value: string): value is ScopeName {
	return (SCOPE_NAMES as readonly string[]).includes(value);
}
