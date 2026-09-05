import type { QueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import type { MessageFilterOptions, MessageFolder } from "./types";
import type { MessageCounts, MessageCountsDelta, MessageListResponse } from "./types";

export const MESSAGE_POLL_INTERVAL_MS = 15_000;
/** A list stays fresh for one "glance"; a folder switch inside it costs no request. */
export const MESSAGE_LIST_STALE_TIME_MS = 15_000;
export const MESSAGE_COUNTS_STALE_TIME_MS = 30_000;
/** Same page size the folder list renders with; prefetch has to match it exactly. */
export const MESSAGE_LIST_PAGE_SIZE = 25;

export function parseMessageSearchQuery(query: string): MessageFilterOptions {
	let remaining = query;
	const filters: MessageFilterOptions = {};
	const titleMatch = remaining.match(/\btitle:"([^"]+)"/i) ?? remaining.match(/\btitle:([^\s]+)/i);

	if (titleMatch?.[1]) {
		filters.title = titleMatch[1].trim();
		remaining = remaining.replace(titleMatch[0], " ");
	}

	if (/(^|\s):unread(\s|$)/i.test(remaining)) {
		filters.read = "unread";
		remaining = remaining.replace(/(^|\s):unread(?=\s|$)/gi, " ");
	} else if (/(^|\s):read(\s|$)/i.test(remaining)) {
		filters.read = "read";
		remaining = remaining.replace(/(^|\s):read(?=\s|$)/gi, " ");
	}

	const textQuery = remaining.replace(/\s+/g, " ").trim();
	if (textQuery) filters.query = textQuery;

	return filters;
}

export function getMessageQueryParams(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	folderId?: string | null,
) {
	const params = new URLSearchParams();

	if (folder === "inbox") {
		params.set("direction", "inbound");
		params.set("status", "received");
	}
	if (folder === "starred") params.set("starred", "true");
	if (folder === "snoozed") params.set("snoozed", "true");

	if (folder === "sent") {
		params.set("direction", "outbound");
		params.set("status", "sent");
	}

	if (folder === "drafts") {
		params.set("direction", "outbound");
		params.set("status", "draft");
	}

	if (folder === "archived" || folder === "trash" || folder === "spam") {
		params.set("status", folder);
	}

	if (folderId) params.set("folderId", folderId);
	if (mailboxId) params.set("mailboxId", mailboxId);
	const searchFilters = filters?.query ? parseMessageSearchQuery(filters.query) : null;
	const parsedFilters = searchFilters
		? { ...filters, ...searchFilters, read: filters?.read ?? searchFilters.read }
		: filters;
	if (parsedFilters?.query?.trim()) params.set("q", parsedFilters.query.trim());
	if (parsedFilters?.title?.trim()) params.set("title", parsedFilters.title.trim());
	if (parsedFilters?.read && parsedFilters.read !== "all") params.set("read", parsedFilters.read);
	if (filters?.limit) params.set("limit", String(filters.limit));
	if (filters?.offset) params.set("offset", String(filters.offset));

	return params;
}

/**
 * React Query keys. Both are prefixed so `invalidateMailQueries` can drop every
 * list or every count set with one call.
 *
 * The filter part is normalised: an empty search box and `read: "all"` do not
 * change the request, so they must not change the key either (otherwise the
 * sidebar prefetch would warm a key the page never reads).
 */
export function messageListQueryKey(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	folderId?: string | null,
) {
	return [
		"messages",
		mailboxId ?? null,
		folder,
		folderId ?? null,
		{
			query: filters?.query?.trim() || null,
			read: filters?.read && filters.read !== "all" ? filters.read : null,
			title: filters?.title?.trim() || null,
			limit: filters?.limit ?? null,
			offset: filters?.offset ?? null,
		},
	] as const;
}

export function messageCountsQueryKey(mailboxId?: string | null) {
	return ["message-counts", mailboxId ?? null] as const;
}

export async function fetchMessageCounts(mailboxId?: string | null): Promise<MessageCounts | undefined> {
	const params = new URLSearchParams();
	if (mailboxId) params.set("mailboxId", mailboxId);
	const query = params.toString();
	const res = await authFetch(`/api/messages/counts${query ? `?${query}` : ""}`);
	const data = (await res.json()) as { counts?: MessageCounts };
	return data.counts;
}

export async function fetchMessageList(params: URLSearchParams): Promise<MessageListResponse> {
	const res = await authFetch(`/api/messages?${params.toString()}`);
	return (await res.json()) as MessageListResponse;
}

/**
 * Warms the exact key `useMessages` reads on the first page of a folder, so a
 * hover over the sidebar makes the click itself free.
 */
export function prefetchFolder(
	queryClient: QueryClient,
	mailboxId: string | null | undefined,
	folder: MessageFolder,
	folderId?: string | null,
) {
	const filters: MessageFilterOptions = { limit: MESSAGE_LIST_PAGE_SIZE, offset: 0 };
	return queryClient.prefetchQuery({
		queryKey: messageListQueryKey(folder, mailboxId, filters, folderId),
		queryFn: () => fetchMessageList(getMessageQueryParams(folder, mailboxId, filters, folderId)),
		staleTime: MESSAGE_LIST_STALE_TIME_MS,
	});
}

/** Single funnel for "the mailbox changed": every list and every count is refetched. */
export function invalidateMailQueries(queryClient: QueryClient): void {
	void queryClient.invalidateQueries({ queryKey: ["messages"] });
	void queryClient.invalidateQueries({ queryKey: ["message-counts"] });
}

/** Optimistic inbox-unread nudge, applied to every cached count set at once. */
export function applyMessageCountsDelta(queryClient: QueryClient, delta: MessageCountsDelta): void {
	const inboxUnreadDelta = delta?.inboxUnreadDelta;
	if (!inboxUnreadDelta) return;
	queryClient.setQueriesData<MessageCounts>({ queryKey: ["message-counts"] }, (current) => {
		if (!current) return current;
		return {
			...current,
			folders: {
				...current.folders,
				inbox: {
					...current.folders.inbox,
					unread: Math.max(0, current.folders.inbox.unread + inboxUnreadDelta),
				},
			},
		};
	});
}
