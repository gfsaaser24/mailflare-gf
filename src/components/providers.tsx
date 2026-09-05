"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { clearMailboxClientState } from "@/components/mailbox-provider-utils";
import { BrandingProvider } from "@/components/branding-provider";
import { NewMessagePopup } from "@/components/new-message-popup";
import { useMessagePolling } from "@/hooks/use-message-polling";
import { applyMessageCountsDelta, invalidateMailQueries } from "@/hooks/utils";
import type { MessageCountsDelta } from "@/hooks/types";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { AUTH_SESSION_CHANGED_EVENT } from "@/lib/auth/client";

/**
 * The one bridge between the legacy `mailflare:*` window events (dispatched from
 * plain modules that have no access to a query client) and React Query.
 *
 * Mounted exactly once, so an optimistic count delta is applied once no matter
 * how many components read the counts.
 */
function MailQueryEvents() {
	const queryClient = useQueryClient();

	useEffect(() => {
		function onMessagesChanged() {
			invalidateMailQueries(queryClient);
		}
		function onCountsDelta(event: Event) {
			applyMessageCountsDelta(queryClient, (event as CustomEvent<MessageCountsDelta>).detail);
		}

		window.addEventListener("mailflare:messages-changed", onMessagesChanged);
		window.addEventListener("mailflare:message-counts-changed", onMessagesChanged);
		window.addEventListener("mailflare:message-counts-delta", onCountsDelta);
		return () => {
			window.removeEventListener("mailflare:messages-changed", onMessagesChanged);
			window.removeEventListener("mailflare:message-counts-changed", onMessagesChanged);
			window.removeEventListener("mailflare:message-counts-delta", onCountsDelta);
		};
	}, [queryClient]);

	return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
	const realtime = useMessagePolling();

	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchOnMount: false,
						refetchOnReconnect: false,
						refetchOnWindowFocus: false,
						staleTime: 60_000,
					},
				},
			}),
	);

	useEffect(() => {
		function resetUserScopedState() {
			client.clear();
			clearMailboxClientState();
			clearMessageDetailCache();
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
		return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, resetUserScopedState);
	}, [client]);

	return (
		<QueryClientProvider client={client}>
			<MailQueryEvents />
			<BrandingProvider>
				{children}
				{realtime.notification && (
					<NewMessagePopup
						notification={realtime.notification}
						onDismiss={realtime.dismissNotification}
					/>
				)}
			</BrandingProvider>
		</QueryClientProvider>
	);
}
