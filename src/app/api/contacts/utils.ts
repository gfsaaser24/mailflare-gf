import { and, eq } from "drizzle-orm";
import { contacts } from "@/db/schema";
import type { OrgContext } from "@/lib/api/with-org";
import { getContactId } from "@/lib/contacts/utils";

export async function getContactByEmail(
	{ db, scoped }: OrgContext,
	userId: string,
	email: string,
) {
	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(scoped(contacts), eq(contacts.userId, userId), eq(contacts.email, email)))
		.limit(1);
	return contact ?? null;
}

export async function saveManualContactName(
	ctx: OrgContext,
	input: { userId: string; email: string; displayName: string },
) {
	const { db, scoped, insertValues } = ctx;
	const existing = await getContactByEmail(ctx, input.userId, input.email);
	if (existing) {
		await db
			.update(contacts)
			.set({ displayName: input.displayName, source: "manual" })
			.where(and(scoped(contacts), eq(contacts.id, existing.id)));
		return { ...existing, displayName: input.displayName, source: "manual" as const };
	}

	const id = getContactId(input.userId, input.email);
	await db.insert(contacts).values(
		insertValues(contacts, {
			id,
			userId: input.userId,
			email: input.email,
			displayName: input.displayName,
			source: "manual",
		}),
	);
	return getContactByEmail(ctx, input.userId, input.email);
}
