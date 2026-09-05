"use client";

import { createContext, useContext, useDeferredValue, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MailSearchContextValue } from "./types";

const MailSearchContext = createContext<MailSearchContextValue | null>(null);

export function useMailSearch() {
	const ctx = useContext(MailSearchContext);
	if (!ctx) throw new Error("useMailSearch must be used within MailSearchProvider");
	return ctx;
}

export function MailSearchProvider({ children }: { children: ReactNode }) {
	const [query, setQuery] = useState("");
	/**
	 * The input renders from `query` (never lags a keystroke); the message list
	 * reads `deferredQuery`, so a slow list render cannot stall typing.
	 */
	const deferredQuery = useDeferredValue(query);
	const value = useMemo<MailSearchContextValue>(
		() => ({ query, deferredQuery, setQuery }),
		[query, deferredQuery],
	);

	return <MailSearchContext.Provider value={value}>{children}</MailSearchContext.Provider>;
}
