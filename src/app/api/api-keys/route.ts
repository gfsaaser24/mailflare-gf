import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiKeys } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import { SCOPE_NAMES } from "@/lib/api/scopes";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { newId } from "@/lib/ids";

const createKeySchema = z.object({
	name: z.string().min(1),
	/** Only catalogue scopes may be issued; see `src/lib/api/scopes.ts`. */
	scopes: z.array(z.enum(SCOPE_NAMES as unknown as [string, ...string[]])).min(1),
	/** Omitted means the key never expires. */
	expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const GET = withOrg(async ({ db, user, scoped }) => {
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			scopes: apiKeys.scopes,
			createdAt: apiKeys.createdAt,
			expiresAt: apiKeys.expiresAt,
			revokedAt: apiKeys.revokedAt,
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

	const { fullKey, prefix, hash, hashAlgo } = generateApiKey();
	const id = newId("key");
	const expiresAt = parsed.data.expiresInDays
		? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
		: null;

	await db.insert(apiKeys).values(
		insertValues(apiKeys, {
			id,
			userId: user.id,
			name: parsed.data.name,
			prefix,
			keyHash: hash,
			hashAlgo,
			scopes: scopesToJson(parsed.data.scopes),
			expiresAt,
		}),
	);

	return NextResponse.json({
		id,
		name: parsed.data.name,
		prefix,
		scopes: parsed.data.scopes,
		expiresAt,
		key: fullKey,
	});
});
