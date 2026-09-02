import { useCallback, useEffect, useState } from "react";
import {
	AUTH_SESSION_CHANGED_EVENT,
	hasClientSession,
} from "@/lib/auth/client";
import type {
	MessageRealtimeState,
	NewMessageEvent,
} from "./message-realtime-types";
import {
	getReconnectDelay,
	getRealtimeEventSourceUrl,
	parseNewMessageEvent,
	REALTIME_FALLBACK_INTERVAL_MS,
	showBrowserNewMessageNotification,
} from "./message-realtime-utils";

export function useMessagePolling(): MessageRealtimeState {
	const [notification, setNotification] = useState<NewMessageEvent | null>(null);
	const dismissNotification = useCallback(() => setNotification(null), []);

	useEffect(() => {
		let source: EventSource | null = null;
		let reconnectTimer: number | null = null;
		let fallbackTimer: number | null = null;
		let reconnectAttempt = 0;
		let stopped = false;

		function dispatchMessagesChanged() {
			window.dispatchEvent(new Event("mailflare:messages-changed"));
		}

		function clearConnectionTimers() {
			if (reconnectTimer) window.clearTimeout(reconnectTimer);
			if (fallbackTimer) window.clearInterval(fallbackTimer);
			reconnectTimer = null;
			fallbackTimer = null;
		}

		function startFallbackRefresh() {
			if (fallbackTimer) return;
			fallbackTimer = window.setInterval(
				dispatchMessagesChanged,
				REALTIME_FALLBACK_INTERVAL_MS,
			);
		}

		function closeSource() {
			if (source) {
				source.onopen = null;
				source.onmessage = null;
				source.onerror = null;
				source.close();
				source = null;
			}
		}

		function scheduleReconnect() {
			closeSource();
			if (stopped || !hasClientSession()) return;
			startFallbackRefresh();
			const delay = getReconnectDelay(reconnectAttempt);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(connect, delay);
		}

		function connect() {
			clearConnectionTimers();
			if (stopped || !hasClientSession()) return;

			source = new EventSource(getRealtimeEventSourceUrl());
			source.onopen = () => {
				reconnectAttempt = 0;
				if (fallbackTimer) {
					window.clearInterval(fallbackTimer);
					fallbackTimer = null;
				}
			};
			source.onmessage = (message) => {
				if (typeof message.data !== "string") return;
				const event = parseNewMessageEvent(message.data);
				if (!event) return;
				dispatchMessagesChanged();
				setNotification(event);
				showBrowserNewMessageNotification(event);
			};
			source.onerror = scheduleReconnect;
		}

		function restartForSessionChange() {
			closeSource();
			clearConnectionTimers();
			reconnectAttempt = 0;
			setNotification(null);
			if (hasClientSession()) connect();
		}

		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, restartForSessionChange);
		connect();

		return () => {
			stopped = true;
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, restartForSessionChange);
			clearConnectionTimers();
			closeSource();
		};
	}, []);

	useEffect(() => {
		if (!notification) return;
		const timer = window.setTimeout(() => setNotification(null), 8_000);
		return () => window.clearTimeout(timer);
	}, [notification]);

	return { notification, dismissNotification };
}
