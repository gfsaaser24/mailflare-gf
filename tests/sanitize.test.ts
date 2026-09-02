import { describe, expect, it } from "vitest";
import {
	sanitizeEmailHtml,
	sanitizeHtmlFields,
	sanitizeStyleAttribute,
} from "@/lib/email/sanitize";

describe("sanitizeEmailHtml", () => {
	it("returns null for empty input", () => {
		expect(sanitizeEmailHtml(null)).toBeNull();
		expect(sanitizeEmailHtml("")).toBeNull();
		expect(sanitizeEmailHtml("   ")).toBeNull();
	});

	it("strips script tags and their contents", () => {
		const clean = sanitizeEmailHtml('<p>hi</p><script>alert("xss")</script>');
		expect(clean).toBe("<p>hi</p>");
		expect(clean).not.toContain("script");
		expect(clean).not.toContain("alert");
	});

	it("strips on* event handlers", () => {
		const clean = sanitizeEmailHtml(
			'<img src="https://example.com/a.png" onerror="alert(1)">',
		);
		expect(clean).not.toContain("onerror");
		expect(clean).not.toContain("alert");
		expect(clean).toContain("https://example.com/a.png");
	});

	it("strips onclick on other elements", () => {
		const clean = sanitizeEmailHtml('<div onclick="alert(1)">text</div>');
		expect(clean).not.toContain("onclick");
		expect(clean).toContain("text");
	});

	it("strips javascript: hrefs but keeps the link text", () => {
		const clean = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
		expect(clean).not.toContain("javascript:");
		expect(clean).not.toContain("href");
		expect(clean).toContain("click");
	});

	it("strips vbscript: hrefs", () => {
		const clean = sanitizeEmailHtml('<a href="vbscript:msgbox(1)">click</a>');
		expect(clean).not.toContain("vbscript:");
		expect(clean).not.toContain("href");
	});

	it("keeps http(s) links and forces rel/target", () => {
		const clean = sanitizeEmailHtml('<a href="https://example.com">go</a>') ?? "";
		expect(clean).toContain('href="https://example.com"');
		expect(clean).toContain('target="_blank"');
		expect(clean).toContain('rel="noopener noreferrer nofollow"');
	});

	it("keeps data:image sources", () => {
		const src =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const clean = sanitizeEmailHtml(`<img src="${src}">`) ?? "";
		expect(clean).toContain("data:image/png;base64,");
	});

	it("drops non-image data: sources", () => {
		const clean = sanitizeEmailHtml(
			'<p>x</p><img src="data:text/html;base64,PHNjcmlwdD4=">',
		);
		expect(clean).not.toContain("data:text/html");
	});

	it("keeps cid: images so inline attachments still resolve", () => {
		const clean = sanitizeEmailHtml('<img src="cid:logo@example.com" alt="Logo">') ?? "";
		expect(clean).toContain('src="cid:logo@example.com"');
		expect(clean).toContain('alt="Logo"');
	});

	it("strips style declarations containing url(javascript:)", () => {
		const clean =
			sanitizeEmailHtml(
				'<div style="color: red; background-image: url(javascript:alert(1))">x</div>',
			) ?? "";
		expect(clean).not.toContain("javascript");
		expect(clean).toContain("color: red");
	});

	it("strips style declarations containing expression()", () => {
		const clean =
			sanitizeEmailHtml('<div style="width: expression(alert(1)); color: blue">x</div>') ??
			"";
		expect(clean).not.toContain("expression");
		expect(clean).toContain("color: blue");
	});

	it("drops iframe, object, embed, form, input, meta, link and base", () => {
		const clean =
			sanitizeEmailHtml(
				[
					"<p>keep</p>",
					'<iframe src="https://evil.test"></iframe>',
					'<object data="x"></object>',
					'<embed src="x">',
					'<form action="https://evil.test"><input name="a"></form>',
					'<meta http-equiv="refresh" content="0;url=https://evil.test">',
					'<link rel="stylesheet" href="https://evil.test/x.css">',
					'<base href="https://evil.test/">',
				].join(""),
			) ?? "";
		for (const tag of ["iframe", "object", "embed", "form", "input", "meta", "link", "base"]) {
			expect(clean).not.toContain(`<${tag}`);
		}
		expect(clean).toContain("keep");
	});

	it("drops style and svg blocks", () => {
		const clean = sanitizeEmailHtml(
			'<style>body{background:url(javascript:alert(1))}</style><svg onload="alert(1)"></svg><p>ok</p>',
		);
		expect(clean).toBe("<p>ok</p>");
	});

	it("keeps normal formatting, tables and lists", () => {
		const clean =
			sanitizeEmailHtml(
				'<table><tbody><tr><td align="left"><b>a</b></td></tr></tbody></table><ul><li>x</li></ul>',
			) ?? "";
		expect(clean).toContain("<table>");
		expect(clean).toContain("<td");
		expect(clean).toContain("<li>x</li>");
	});

	it("is idempotent", () => {
		const once = sanitizeEmailHtml('<a href="https://example.com">go</a><p>hi</p>');
		expect(sanitizeEmailHtml(once)).toBe(once);
	});
});

describe("sanitizeStyleAttribute", () => {
	it("keeps http image urls", () => {
		expect(sanitizeStyleAttribute("background: url(https://example.com/a.png)")).toContain(
			"https://example.com/a.png",
		);
	});

	it("drops data:text urls", () => {
		expect(sanitizeStyleAttribute("background: url(data:text/html,<script>)")).toBe("");
	});

	it("drops @import and behavior", () => {
		expect(sanitizeStyleAttribute("@import url(https://evil.test/x.css)")).toBe("");
		expect(sanitizeStyleAttribute("behavior: url(#default#time2)")).toBe("");
	});
});

describe("sanitizeHtmlFields", () => {
	it("sanitises html fields anywhere in a webhook payload", () => {
		const payload = sanitizeHtmlFields({
			messageId: "m1",
			subject: "<script>nope</script>",
			body: { html: '<p>hi</p><script>alert(1)</script>', text: "hi" },
			items: [{ htmlBody: '<img src="x" onerror="alert(1)">' }],
		});

		expect(payload.body.html).toBe("<p>hi</p>");
		expect(payload.body.text).toBe("hi");
		// Non-HTML fields are left untouched.
		expect(payload.subject).toBe("<script>nope</script>");
		expect(payload.items[0].htmlBody ?? "").not.toContain("onerror");
	});
});
