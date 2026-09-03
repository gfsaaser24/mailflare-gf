/**
 * Bodies for the two self-service auth mails: password reset and magic link.
 *
 * Rules that must not be lost:
 * - the raw token only ever appears inside the link handed to the recipient; it
 *   is never logged and never returned in an API response;
 * - no external assets, no inline scripts, no remote images. These messages are
 *   read in hostile clients and must survive a strict sanitiser;
 * - every mail names the IP that asked for it and tells the reader to ignore the
 *   message when it was not them, so a stolen-address attempt is visible.
 */

export type AuthEmailBody = {
	subject: string;
	text: string;
	html: string;
};

export type AuthEmailInput = {
	/** Absolute link built with `authLinkUrl()`. */
	url: string;
	/** IP the request came from, for the abuse trail. */
	requestIp?: string | null;
	/** Lifetime of the link, in whole minutes. */
	expiresInMinutes: number;
};

/**
 * Absolute URL for a link that will be emailed.
 *
 * Deliberately throws instead of degrading to a site-relative path: a relative
 * link in an email client is dead, and silently sending a broken reset link is
 * worse than a 500 that names the missing setting.
 */
export function authLinkUrl(env: Pick<AppEnv, "APP_URL">, path: string): string {
	const base = (env.APP_URL ?? "").trim().replace(/\/+$/, "");
	if (!base) {
		throw new Error("APP_URL is not set: cannot build an absolute link for a system email.");
	}
	return `${base}${path}`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function originLine(requestIp?: string | null): string {
	const ip = requestIp?.trim();
	return ip && ip !== "unknown"
		? `The request came from ${ip}.`
		: "The request came from an unknown address.";
}

function render(input: {
	subject: string;
	lead: string;
	action: string;
	url: string;
	expiresInMinutes: number;
	requestIp?: string | null;
}): AuthEmailBody {
	const expiry = `The link works once and expires in ${input.expiresInMinutes} minutes.`;
	const origin = originLine(input.requestIp);
	const ignore = "If this wasn't you, ignore this email — nothing has changed.";

	const text = [input.lead, "", input.action, input.url, "", expiry, origin, "", ignore].join("\n");

	const html = [
		'<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#171717">',
		`<p>${escapeHtml(input.lead)}</p>`,
		`<p>${escapeHtml(input.action)}</p>`,
		`<p><a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a></p>`,
		`<p style="color:#525252">${escapeHtml(expiry)} ${escapeHtml(origin)}</p>`,
		`<p style="color:#525252">${escapeHtml(ignore)}</p>`,
		"</div>",
	].join("");

	return { subject: input.subject, text, html };
}

export function passwordResetEmail(input: AuthEmailInput): AuthEmailBody {
	return render({
		subject: "Reset your password",
		lead: "Someone asked to reset the password for your account.",
		action: "Choose a new password here:",
		url: input.url,
		expiresInMinutes: input.expiresInMinutes,
		requestIp: input.requestIp,
	});
}

export function magicLinkEmail(input: AuthEmailInput): AuthEmailBody {
	return render({
		subject: "Your sign-in link",
		lead: "Someone asked for a sign-in link for your account.",
		action: "Continue to sign in here:",
		url: input.url,
		expiresInMinutes: input.expiresInMinutes,
		requestIp: input.requestIp,
	});
}
