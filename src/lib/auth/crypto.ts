/**
 * Symmetric encryption for auth secrets at rest (TOTP shared secrets).
 *
 * AES-256-GCM, key from `AUTH_ENCRYPTION_KEY` (32 bytes, base64 or hex).
 * Ciphertext format is `v1.<iv b64>.<ct b64>.<tag b64>` — versioned so a future
 * key rotation or cipher change can be told apart from the current one.
 *
 * The key is deliberately NOT derived from anything else: losing it means every
 * enrolled TOTP secret is unreadable and users must re-enrol, which is the right
 * failure mode. Generate one with `openssl rand -base64 32`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function getKey(env: CloudflareEnv): Buffer {
	const raw = env.AUTH_ENCRYPTION_KEY ?? process.env.AUTH_ENCRYPTION_KEY;
	if (!raw) {
		throw new Error(
			"AUTH_ENCRYPTION_KEY is not set: two-factor secrets cannot be encrypted. Generate one with `openssl rand -base64 32`.",
		);
	}
	const key = decodeKey(raw.trim());
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`AUTH_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); use \`openssl rand -base64 32\`.`,
		);
	}
	return key;
}

function decodeKey(raw: string): Buffer {
	// 64 hex characters is unambiguous; anything else is read as base64.
	if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
	return Buffer.from(raw, "base64");
}

export function encryptSecret(env: CloudflareEnv, plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", getKey(env), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [VERSION, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(".");
}

export function decryptSecret(env: CloudflareEnv, ciphertext: string): string {
	const parts = ciphertext.split(".");
	if (parts.length !== 4 || parts[0] !== VERSION) {
		throw new Error("Encrypted secret is malformed or was written by a newer version");
	}
	const [, ivB64, ctB64, tagB64] = parts;
	const decipher = createDecipheriv("aes-256-gcm", getKey(env), Buffer.from(ivB64, "base64"));
	decipher.setAuthTag(Buffer.from(tagB64, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
