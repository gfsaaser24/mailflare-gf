import DOMPurify from "isomorphic-dompurify";

/**
 * Server-side HTML sanitisation for inbound (and stored) email bodies.
 *
 * This runs once, on the server, before the HTML is persisted in
 * `messages.html_body`. Everything downstream — the UI, `/api/messages/**`,
 * `/api/v1/messages`, mbox export and webhooks — reads the already-sanitised
 * body, so no consumer has to trust raw MIME. The raw message stays untouched
 * in object storage.
 */

/** Formatting / table / list / link / image tags an email may legitimately use. */
const ALLOWED_TAGS = [
	"a",
	"abbr",
	"address",
	"b",
	"bdi",
	"bdo",
	"blockquote",
	"br",
	"caption",
	"center",
	"cite",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
	"dfn",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"font",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"pre",
	"q",
	"s",
	"samp",
	"small",
	"span",
	"strong",
	"sub",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"time",
	"tr",
	"u",
	"ul",
	"var",
	"wbr",
];

const ALLOWED_ATTR = [
	"align",
	"alt",
	"bgcolor",
	"border",
	"cellpadding",
	"cellspacing",
	"cite",
	"color",
	"colspan",
	"datetime",
	"dir",
	"face",
	"height",
	"href",
	"lang",
	"rowspan",
	"scope",
	"size",
	"span",
	"src",
	"start",
	"style",
	"title",
	"type",
	"valign",
	"value",
	"width",
];

/**
 * Tags that are dropped outright (content included). `style` is here on
 * purpose: a stylesheet can smuggle `url(javascript:)`/`expression()` and can
 * restyle the surrounding app when the body is rendered inline.
 */
const FORBID_TAGS = [
	"applet",
	"audio",
	"base",
	"body",
	"button",
	"embed",
	"form",
	"frame",
	"frameset",
	"head",
	"html",
	"iframe",
	"input",
	"link",
	"math",
	"meta",
	"noscript",
	"object",
	"option",
	"script",
	"select",
	"style",
	"svg",
	"template",
	"textarea",
	"title",
	"video",
];

/**
 * Attributes that survive the allowlist in odd browsers or that re-introduce
 * network/navigation control. `on*` handlers are covered by the allowlist
 * itself, and belt-and-braces by `stripEventHandlers()`.
 */
const FORBID_ATTR = [
	"action",
	"autofocus",
	"background",
	"formaction",
	"onerror",
	"onload",
	"ping",
	"poster",
	"srcdoc",
	"srcset",
	"xlink:href",
];

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:", "cid:"]);
const DATA_IMAGE_RE = /^data:image\/(?:apng|avif|bmp|gif|jpeg|jpg|png|svg\+xml|webp)[;,]/i;
const DANGEROUS_CSS_RE = /expression\s*\(|javascript\s*:|vbscript\s*:|@import|behavior\s*:|-moz-binding|url\s*\(\s*["']?\s*(?:javascript|vbscript|data)\s*:/i;
const CSS_URL_RE = /url\s*\(\s*(["']?)([^"')]*)\1\s*\)/gi;

/** A base that lets us parse relative URLs without leaking a real origin. */
const URL_BASE = "https://mailflare.invalid/";

function protocolOf(value: string): string | null {
	try {
		return new URL(value.trim(), URL_BASE).protocol;
	} catch {
		return null;
	}
}

function isSafeLinkUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("#")) return false;
	const protocol = protocolOf(trimmed);
	return protocol !== null && LINK_PROTOCOLS.has(protocol);
}

function isSafeImageUrl(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	// `cid:` images are resolved to an attachment URL by the UI at render time.
	if (/^cid:/i.test(trimmed)) return true;
	if (/^data:/i.test(trimmed)) return DATA_IMAGE_RE.test(trimmed);
	// Already-resolved inline attachment URLs stay usable on re-sanitisation.
	if (trimmed.startsWith("/api/messages/")) return true;
	const protocol = protocolOf(trimmed);
	return protocol !== null && IMAGE_PROTOCOLS.has(protocol);
}

/** Keeps declarations that cannot execute code or fetch from odd schemes. */
export function sanitizeStyleAttribute(style: string): string {
	const kept: string[] = [];
	for (const rawDeclaration of style.split(";")) {
		const declaration = rawDeclaration.trim();
		if (!declaration) continue;
		if (DANGEROUS_CSS_RE.test(declaration)) continue;

		let urlsAreSafe = true;
		CSS_URL_RE.lastIndex = 0;
		for (const match of declaration.matchAll(CSS_URL_RE)) {
			if (!isSafeImageUrl(match[2] ?? "")) {
				urlsAreSafe = false;
				break;
			}
		}
		if (!urlsAreSafe) continue;

		kept.push(declaration);
	}
	return kept.join("; ");
}

function stripEventHandlers(node: Element): void {
	for (const attribute of Array.from(node.attributes)) {
		if (attribute.name.toLowerCase().startsWith("on")) {
			node.removeAttribute(attribute.name);
		}
	}
}

let hooksInstalled = false;

function installHooks(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;

	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		// `instanceof Element` is unusable here: isomorphic-dompurify runs on its
		// own jsdom window, so the global constructor does not exist on the
		// server. Duck-type against the element node type instead.
		const element = node as unknown as Element;
		if (element?.nodeType !== 1 || typeof element.getAttribute !== "function") return;
		stripEventHandlers(element);

		const tag = element.tagName?.toLowerCase();

		if (element.hasAttribute("style")) {
			const style = sanitizeStyleAttribute(element.getAttribute("style") ?? "");
			if (style) element.setAttribute("style", style);
			else element.removeAttribute("style");
		}

		if (tag === "a") {
			const href = element.getAttribute("href");
			// Removed first so the attribute order is stable across repeated
			// sanitisation of an already-sanitised body.
			element.removeAttribute("target");
			element.removeAttribute("rel");
			if (href && isSafeLinkUrl(href)) {
				element.setAttribute("target", "_blank");
				element.setAttribute("rel", "noopener noreferrer nofollow");
			} else {
				element.removeAttribute("href");
				element.removeAttribute("target");
			}
		}

		if (tag === "img") {
			const src = element.getAttribute("src");
			if (!src || !isSafeImageUrl(src)) {
				element.remove();
				return;
			}
			element.setAttribute("loading", "lazy");
			element.setAttribute("referrerpolicy", "no-referrer");
		}
	});
}

/**
 * Sanitise an email HTML body. Returns `null` for empty input so callers can
 * store a NULL `html_body` rather than an empty string.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
	if (!html) return null;
	installHooks();
	const clean = DOMPurify.sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		FORBID_TAGS,
		FORBID_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		ALLOW_UNKNOWN_PROTOCOLS: false,
		KEEP_CONTENT: true,
		RETURN_TRUSTED_TYPE: false,
		WHOLE_DOCUMENT: false,
		SAFE_FOR_TEMPLATES: false,
		USE_PROFILES: { html: true },
	});
	const trimmed = typeof clean === "string" ? clean.trim() : "";
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Recursively sanitise any `html`/`htmlBody`/`html_body` string in an outgoing
 * payload (webhooks, exports). Non-HTML values are left alone.
 */
export function sanitizeHtmlFields<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeHtmlFields(item)) as unknown as T;
	}
	if (value === null || typeof value !== "object") return value;

	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		const isHtmlField = /^(html|html_?body|body_?html)$/i.test(key);
		if (isHtmlField && typeof entry === "string") {
			result[key] = sanitizeEmailHtml(entry);
		} else {
			result[key] = sanitizeHtmlFields(entry);
		}
	}
	return result as unknown as T;
}
