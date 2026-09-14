import type { AttachmentContent } from "@/lib/email/attachment-types";

export interface SendRequestPayload {
	attachments?: AttachmentContent[];
	from: string;
	html?: string;
	mailboxId?: string;
	subject: string;
	text?: string;
	/** One address, or a comma/semicolon separated list; `sendEmailSchema` splits it. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
}
