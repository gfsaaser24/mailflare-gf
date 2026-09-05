import type { QueryClient } from "@tanstack/react-query";
import { prefetchFolder } from "@/hooks/utils";
import type { MessageFolder } from "@/hooks/types";

const supportedFolders: MessageFolder[] = [
	"inbox",
	"starred",
	"snoozed",
	"sent",
	"drafts",
	"archived",
	"spam",
	"trash",
];

/** Maps a sidebar href onto the folder the messages query uses, or null. */
export function getNavFolderTarget(href: string): { folder: MessageFolder; folderId?: string } | null {
	const customFolderMatch = href.match(/^\/folders\/([^/]+)$/);
	const folder = (customFolderMatch ? "inbox" : href.slice(1)) as MessageFolder;
	if (!supportedFolders.includes(folder)) return null;
	return { folder, folderId: customFolderMatch?.[1] };
}

/**
 * Warms the first page of a folder in the query cache. Called on hover/focus,
 * so the click that follows renders from cache instead of waiting on the API.
 */
export function preloadMailboxPage(queryClient: QueryClient, href: string, mailboxId?: string): void {
	const target = getNavFolderTarget(href);
	if (!target) return;
	void prefetchFolder(queryClient, mailboxId, target.folder, target.folderId);
}
