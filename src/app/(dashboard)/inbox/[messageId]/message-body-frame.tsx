"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const FRAME_STYLES = `
  html, body { margin: 0; padding: 0; }
  body {
    color: #171717;
    font-family: var(--font-geist-sans), system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  img, video, table { max-width: 100%; }
  img { height: auto; }
  table { border-collapse: collapse; }
  a { color: #2563eb; }
  blockquote {
    border-left: 3px solid #e5e5e5;
    margin: 0 0 0 0.5rem;
    padding-left: 0.75rem;
  }
  pre { white-space: pre-wrap; }
`;

/**
 * The body is already sanitised twice (server-side at parse time, then again on
 * the client as defence in depth). The iframe is the third layer: no
 * `allow-scripts`, no `allow-forms`, no `allow-top-navigation`, so nothing in
 * the document can run or navigate us.
 *
 * `allow-same-origin` is kept on purpose. Without it the frame gets an opaque
 * origin, which drops cookies from `/api/messages/.../attachments/...` requests
 * and breaks every inline (`cid:`) image. Scripts still cannot execute — the
 * sandbox withholds `allow-scripts` and the page CSP has no `'unsafe-inline'`
 * for `script-src` — so same-origin buys the frame no capability.
 */
const SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

function buildSrcDoc(html: string): string {
	return [
		"<!doctype html>",
		'<html><head><meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		// Every link opens in a new tab; the sandbox cannot navigate the top frame.
		'<base target="_blank">',
		`<style>${FRAME_STYLES}</style>`,
		"</head><body>",
		html,
		"</body></html>",
	].join("");
}

export function MessageBodyFrame({ html }: { html: string }) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(0);

	const resize = useCallback(() => {
		const frame = frameRef.current;
		const doc = frame?.contentDocument;
		if (!doc?.body) return;
		const next = Math.max(
			doc.body.scrollHeight,
			doc.documentElement?.scrollHeight ?? 0,
		);
		setHeight((current) => (Math.abs(current - next) > 1 ? next : current));
	}, []);

	useEffect(() => {
		// Images and web fonts land after `load`, so keep watching for a while.
		const frame = frameRef.current;
		if (!frame) return;
		const interval = window.setInterval(resize, 250);
		const timeout = window.setTimeout(() => window.clearInterval(interval), 5000);
		return () => {
			window.clearInterval(interval);
			window.clearTimeout(timeout);
		};
	}, [resize, html]);

	return (
		<iframe
			ref={frameRef}
			title="Message body"
			sandbox={SANDBOX}
			referrerPolicy="no-referrer"
			srcDoc={buildSrcDoc(html)}
			onLoad={resize}
			scrolling="no"
			className="mx-auto block w-full border-0"
			style={{ height: height ? `${height}px` : "8rem" }}
		/>
	);
}
