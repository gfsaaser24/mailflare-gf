import { authFetch, hasClientSession } from "@/lib/auth/client";
import type { MailboxOption } from "./mailbox-provider";

let mailboxesCache: MailboxOption[] | null = null;
// The session token is no longer readable (httpOnly cookie); the cache is keyed
// on whether a session exists, which is what it actually needed to detect.
let mailboxesCacheSession: boolean | null = null;
let mailboxesRequest: Promise<MailboxOption[]> | null = null;
let mailboxesRequestSession: boolean | null = null;
let cacheGeneration = 0;
export const SELECTED_MAILBOX_STORAGE_KEY = "selected-mailbox-id";

export function clearMailboxesCache() {
	cacheGeneration += 1;
	mailboxesCache = null;
	mailboxesCacheSession = null;
	mailboxesRequest = null;
	mailboxesRequestSession = null;
}

export function clearMailboxClientState() {
	clearMailboxesCache();
	if (typeof window !== "undefined") {
		localStorage.removeItem(SELECTED_MAILBOX_STORAGE_KEY);
	}
}

export async function fetchMailboxOptions(force = false): Promise<MailboxOption[]> {
	const session = hasClientSession();
	if (!force && mailboxesCache && mailboxesCacheSession === session) return mailboxesCache;
	if (!force && mailboxesRequest && mailboxesRequestSession === session) return mailboxesRequest;

	const requestGeneration = cacheGeneration;
	mailboxesRequestSession = session;
	mailboxesRequest = authFetch("/api/mailboxes")
		.then((res) => res.json())
		.then((data) => {
			const items = ((data as { mailboxes?: MailboxOption[] }).mailboxes ?? []).map((m) => ({
				id: m.id,
				localPart: m.localPart,
				hostname: m.hostname,
				displayName: m.displayName,
				signature: m.signature,
				autoReplyEnabled: m.autoReplyEnabled,
				autoReplySubject: m.autoReplySubject,
				autoReplyBody: m.autoReplyBody,
				hasAvatar: m.hasAvatar,
				type: m.type,
				permission: m.permission,
				isPrimary: m.isPrimary,
				senderAddresses: m.senderAddresses,
			}));
			if (requestGeneration === cacheGeneration) {
				mailboxesCache = items;
				mailboxesCacheSession = session;
			}
			return items;
		})
		.finally(() => {
			if (requestGeneration === cacheGeneration) {
				mailboxesRequest = null;
				mailboxesRequestSession = null;
			}
		});

	return mailboxesRequest;
}
