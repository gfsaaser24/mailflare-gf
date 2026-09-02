import type { contacts } from "@/db/schema";
import type { ContactSource } from "@/lib/email/address-types";

export type ContactRow = typeof contacts.$inferSelect;

export type ContactInput = {
	/**
	 * Organisation the contact belongs to (`ctx.orgId`). Optional only for the
	 * inbound/outbound mail paths that have not been threaded yet; those fall
	 * back to the default organisation, which is what the column default already
	 * gave them.
	 */
	organizationId?: string;
	userId: string;
	address: string;
	source: ContactSource;
};

export type BlockContactInput = {
	/** Organisation the contact and the block rule belong to (`ctx.orgId`). */
	organizationId: string;
	userId: string;
	mailboxId: string;
	domainId: string;
	address: string;
};

export type MessageContactNames = {
	fromContactName: string | null;
	toContactName: string | null;
};
