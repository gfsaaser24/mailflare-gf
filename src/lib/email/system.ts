/**
 * System mail: password reset, magic link, security notices.
 *
 * Deliberately NOT `sendEmail()` (`./send.ts`). User mail is owned by a mailbox:
 * it books quota, writes a `messages` row, threads into a conversation and shows
 * up in Sent. System mail belongs to nobody, so it goes straight to the
 * transport and leaves no trace in a user's mailbox.
 *
 * From address: `SYSTEM_EMAIL_FROM` when set, else `no-reply@<primary domain>`.
 */
import { getPrimaryDomain } from "@/lib/user";

export type SystemEmailInput = {
	to: string;
	subject: string;
	text: string;
	html?: string;
};

export async function sendSystemEmail(env: CloudflareEnv, input: SystemEmailInput): Promise<void> {
	const from = await resolveSystemFrom(env);
	await env.EMAIL.send({
		from,
		to: input.to,
		subject: input.subject,
		text: input.text,
		html: input.html,
		// Keeps auto-responders (including our own) from answering system mail.
		headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
	});
}

/** The address system mail is sent from. Throws when neither source is available. */
export async function resolveSystemFrom(env: CloudflareEnv): Promise<string> {
	const configured = (env.SYSTEM_EMAIL_FROM ?? process.env.SYSTEM_EMAIL_FROM)?.trim();
	if (configured) return configured;

	const domain = await getPrimaryDomain(env);
	if (domain?.hostname) return `no-reply@${domain.hostname}`;

	throw new Error(
		"Cannot send system email: set SYSTEM_EMAIL_FROM, or add a domain so no-reply@<domain> can be used.",
	);
}
