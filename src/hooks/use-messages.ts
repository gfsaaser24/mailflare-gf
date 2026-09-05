import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { SetStateAction } from "react";
import type { Message, MessageFilterOptions, MessageFolder, MessageListResponse } from "./types";
import {
	fetchMessageList,
	getMessageQueryParams,
	MESSAGE_LIST_STALE_TIME_MS,
	MESSAGE_POLL_INTERVAL_MS,
	messageListQueryKey,
} from "./utils";

/** Stable identity: a new `[]` every render would restart every dependent effect. */
const emptyMessages: Message[] = [];

export function useMessages(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
	enabled = true,
	folderId?: string | null,
) {
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => messageListQueryKey(folder, mailboxId, filters, folderId),
		// The key builder already normalises the filter set; spelling the fields
		// out keeps the memo from re-running on every fresh `filters` object.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[folder, mailboxId, folderId, filters?.query, filters?.read, filters?.title, filters?.limit, filters?.offset],
	);

	const query = useQuery({
		queryKey,
		queryFn: () => fetchMessageList(getMessageQueryParams(folder, mailboxId, filters, folderId)),
		enabled,
		// Keeps the previous folder/page on screen while the next one loads.
		placeholderData: keepPreviousData,
		staleTime: MESSAGE_LIST_STALE_TIME_MS,
		refetchInterval: MESSAGE_POLL_INTERVAL_MS,
	});

	const data: MessageListResponse | undefined = query.data;
	const messages = data?.messages ?? emptyMessages;
	const unreadCount = useMemo(
		() => messages.filter((message) => message.direction === "inbound" && !message.read).length,
		[messages],
	);

	/**
	 * Same contract as the old `setMessages`: optimistic row updates write
	 * straight into the cache entry the list is rendering.
	 */
	const updateMessages = useCallback(
		(update: SetStateAction<Message[]>) => {
			queryClient.setQueryData<MessageListResponse>(queryKey, (current) => {
				const currentMessages = current?.messages ?? [];
				const nextMessages =
					typeof update === "function"
						? (update as (previous: Message[]) => Message[])(currentMessages)
						: update;
				return { ...current, messages: nextMessages };
			});
		},
		[queryClient, queryKey],
	);

	return {
		messages,
		unreadCount,
		// True only when nothing at all can be shown yet: with placeholder data
		// from the previous folder or page this stays false.
		isLoading: !enabled || (query.isPending && data === undefined),
		isFetching: query.isFetching,
		isPlaceholderData: query.isPlaceholderData,
		total: data?.total ?? 0,
		limit: data?.limit ?? filters?.limit ?? 25,
		offset: data?.offset ?? filters?.offset ?? 0,
		updateMessages,
	};
}
