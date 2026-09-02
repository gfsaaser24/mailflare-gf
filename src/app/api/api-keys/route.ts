import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiKeys } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { newId } from "@/lib/ids";

const createKeySchema = z.object({
	name: z.string().min(1),
	scopes: z.array(z.enum(["send", "read"])).min(1),
});

export const GET = withOrg(async ({ db, user, scoped }) => {
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			scopes: apiKeys.scopes,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.where(and(scoped(apiKeys), eq(apiKeys.userId, user.id)));
	return NextResponse.json({ apiKeys: rows });
});

export const POST = withOrg(async ({ db, user, insertValues }, request) => {
	const parsed = createKeySchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const { fullKey, prefix, hash } = generateApiKey();
	const id = newId("key");
	await db.insert(apiKeys).values(
		insertValues(apiKeys, {
			id,
			userId: user.id,
			name: parsed.data.name,
			prefix,
			keyHash: hash,
			scopes: scopesToJson(parsed.data.scopes),
		}),
	);

	return NextResponse.json({ id, name: parsed.data.name, prefix, key: fullKey });
});
