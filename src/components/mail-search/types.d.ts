export type MailSearchContextValue = {
	query: string;
	/** `query` behind `useDeferredValue`; what the messages query should read. */
	deferredQuery: string;
	setQuery: (query: string) => void;
};
