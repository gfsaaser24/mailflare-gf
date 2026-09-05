import { useQuery } from "@tanstack/react-query";
import type { MessageCounts } from "./types";
import {
	fetchMessageCounts,
	MESSAGE_COUNTS_STALE_TIME_MS,
	MESSAGE_POLL_INTERVAL_MS,
	messageCountsQueryKey,
} from "./utils";

const emptyCounts: MessageCounts = {
	folders: {
		inbox: { total: 0, unread: 0 },
		starred: { total: 0, unread: 0 },
		snoozed: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		archived: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	},
	customFolders: {},
	mailboxes: [],
};

export function useMessageCounts(mailboxId?: string | null, enabled = true) {
	const query = useQuery({
		queryKey: messageCountsQueryKey(mailboxId),
		queryFn: async () => (await fetchMessageCounts(mailboxId)) ?? emptyCounts,
		enabled,
		// Counts for the previous mailbox stay on the sidebar while the next set loads.
		placeholderData: (previous) => previous,
		staleTime: MESSAGE_COUNTS_STALE_TIME_MS,
		refetchInterval: MESSAGE_POLL_INTERVAL_MS,
	});

	return {
		counts: query.data ?? emptyCounts,
		isLoading: enabled && query.isPending && query.data === undefined,
		isFetching: query.isFetching,
		isPlaceholderData: query.isPlaceholderData,
	};
}
