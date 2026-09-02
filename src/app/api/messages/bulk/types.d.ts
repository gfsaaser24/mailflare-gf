/** `delete` is the permanent one (empty trash); `trash` only moves the message. */
export type BulkMessageAction =
	| "archive"
	| "trash"
	| "spam"
	| "read"
	| "unread"
	| "inbox"
	| "folder"
	| "delete";

export type BulkMessagePayload = {
	messageIds?: string[];
	action?: BulkMessageAction;
	folderId?: string;
};
