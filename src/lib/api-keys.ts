import { createHash, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { newId } from "@/lib/ids";

const KEY_PREFIX = "ep_";

/**
 * How an `api_keys.key_hash` value was produced.
 *
 * `bcrypt` only exists for rows issued before T6.1. API keys are high-entropy
 * random strings, so a password KDF buys nothing and costs a bcrypt round on
 * every single API call; new keys are plain SHA-256.
 */
export type HashAlgo = "sha256" | "bcrypt";

/** The algorithm every newly issued key uses. */
export const DEFAULT_HASH_ALGO: HashAlgo = "sha256";

export function hashApiKey(fullKey: string): string {
	return createHash("sha256").update(fullKey).digest("hex");
}

export function generateApiKey(): {
	fullKey: string;
	prefix: string;
	hash: string;
	hashAlgo: HashAlgo;
} {
	const secret = newId();
	const fullKey = `${KEY_PREFIX}${secret}`;
	const prefix = fullKey.slice(0, 12);
	return { fullKey, prefix, hash: hashApiKey(fullKey), hashAlgo: DEFAULT_HASH_ALGO };
}

/**
 * Verifies a presented key against a stored hash.
 *
 * `hashAlgo` comes from the row. It defaults to `sha256` so callers that do not
 * have the column handy still do the right thing for new keys; legacy rows
 * carry `bcrypt` explicitly.
 */
export function verifyApiKey(
	fullKey: string,
	hash: string,
	hashAlgo: string = DEFAULT_HASH_ALGO,
): boolean {
	if (hashAlgo === "bcrypt") return bcrypt.compareSync(fullKey, hash);
	const expected = Buffer.from(hash, "hex");
	const actual = Buffer.from(hashApiKey(fullKey), "hex");
	if (expected.length !== actual.length || expected.length === 0) return false;
	return timingSafeEqual(expected, actual);
}

export function parseScopes(scopesJson: string): string[] {
	try {
		const parsed = JSON.parse(scopesJson) as unknown;
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

export function scopesToJson(scopes: string[]): string {
	return JSON.stringify(scopes);
}
