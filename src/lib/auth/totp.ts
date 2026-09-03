/**
 * TOTP (authenticator app) primitives.
 *
 * Everything here is pure except `getTotpIssuer()`, which reads the primary
 * domain so the authenticator entry is labelled with the deployment rather than
 * a generic name. Storage concerns live with the callers:
 *
 * - the shared secret is encrypted at rest with `AUTH_ENCRYPTION_KEY`
 *   (`src/lib/auth/crypto.ts`) and is only ever returned to the browser during
 *   enrolment, from `POST /api/auth/two-factor/setup`;
 * - backup codes are shown once, in plain text, and stored as bcrypt hashes in
 *   `users.totp_backup_codes` (a JSON array of strings). A used code is removed
 *   from the array, so a code works exactly once.
 *
 * Backup codes use bcrypt at cost 10 rather than the cost 12 of a password:
 * verifying a code means comparing against up to `BACKUP_CODE_COUNT` hashes in
 * one request, and that walk sits on the login path.
 */
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, organizations } from "@/db/schema";

/** Shown to the user once, at enrolment and on regeneration. */
export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_COST = 10;
/** No 0/1/i/l/o: a code is read off a screen and typed back by hand. */
const BACKUP_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const BACKUP_CODE_GROUP = 4;
/** ±1 step of the 30-second period, expressed in seconds as otplib wants it. */
const EPOCH_TOLERANCE_SECONDS = 30;
/** Fallback issuer when the deployment has no domain yet. */
const DEFAULT_ISSUER = "Mailflare";

/** A fresh base32 shared secret for one user. */
export function generateTotpSecret(): string {
	return generateSecret();
}

/**
 * Issuer shown in the authenticator: the primary domain hostname, or
 * `Mailflare` before any domain exists. Never throws — a database hiccup must
 * not stop someone enrolling.
 */
export async function getTotpIssuer(env: CloudflareEnv): Promise<string> {
	try {
		const [row] = await getDb(env).select({ hostname: domains.hostname }).from(domains).limit(1);
		return row?.hostname || DEFAULT_ISSUER;
	} catch {
		return DEFAULT_ISSUER;
	}
}

/**
 * Whether the organisation forces every member to enrol
 * (`organizations.require_two_factor`). A missing row reads as "no": the gate
 * must fail open on a lookup, never lock an org out of its own settings.
 */
export async function organizationRequiresTwoFactor(
	db: AppDatabase,
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ requireTwoFactor: organizations.requireTwoFactor })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return row?.requireTwoFactor ?? false;
}

/** The `otpauth://totp/...` URI an authenticator app scans. */
export function buildOtpauthUrl(input: {
	issuer: string;
	label: string;
	secret: string;
}): string {
	return generateURI({
		strategy: "totp",
		issuer: input.issuer,
		label: input.label,
		secret: input.secret,
	});
}

/** Strips spaces and anything that is not a digit; authenticators show `123 456`. */
export function normalizeTotpCode(input: string): string {
	return input.replace(/\D+/g, "");
}

/** True for a six-digit authenticator code, with a ±1 step window. */
export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
	const token = normalizeTotpCode(code);
	if (token.length !== 6) return false;
	try {
		const result = await verify({
			secret,
			token,
			strategy: "totp",
			epochTolerance: EPOCH_TOLERANCE_SECONDS,
		});
		return result.valid;
	} catch {
		// A malformed secret or token is a failed verification, never a 500.
		return false;
	}
}

function randomBackupGroup(): string {
	let group = "";
	for (let i = 0; i < BACKUP_CODE_GROUP; i += 1) {
		group += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
	}
	return group;
}

/** One `xxxx-xxxx` recovery code. */
export function generateBackupCode(): string {
	return `${randomBackupGroup()}-${randomBackupGroup()}`;
}

/**
 * A fresh set of recovery codes. `codes` is shown to the user exactly once;
 * `hashes` is what goes into `users.totp_backup_codes`.
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): {
	codes: string[];
	hashes: string[];
} {
	const codes = Array.from({ length: count }, () => generateBackupCode());
	return { codes, hashes: codes.map((code) => bcrypt.hashSync(code, BACKUP_CODE_COST)) };
}

/** Lower-cased, punctuation-free, re-hyphenated: `AB12CD34` -> `ab12-cd34`. */
export function normalizeBackupCode(input: string): string {
	const compact = input.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (compact.length !== BACKUP_CODE_GROUP * 2) return compact;
	return `${compact.slice(0, BACKUP_CODE_GROUP)}-${compact.slice(BACKUP_CODE_GROUP)}`;
}

/** True when the input looks like a recovery code rather than a TOTP code. */
export function isBackupCodeFormat(input: string): boolean {
	return /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(normalizeBackupCode(input));
}

/** Reads the stored JSON array of hashes; anything unusable reads as empty. */
export function parseBackupCodeHashes(stored: string | null | undefined): string[] {
	if (!stored) return [];
	try {
		const parsed = JSON.parse(stored) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}

/** The column value for a set of hashes. */
export function serializeBackupCodeHashes(hashes: string[]): string {
	return JSON.stringify(hashes);
}

/**
 * Verifies a recovery code and burns it.
 *
 * Returns the hashes that remain when it matched, so the caller writes back a
 * list with that one code gone. `matched: false` leaves the list untouched.
 */
export function consumeBackupCode(
	stored: string | null | undefined,
	code: string,
): { matched: boolean; remainingHashes: string[] } {
	const hashes = parseBackupCodeHashes(stored);
	const candidate = normalizeBackupCode(code);
	if (!isBackupCodeFormat(candidate)) return { matched: false, remainingHashes: hashes };

	const index = hashes.findIndex((hash) => {
		try {
			return bcrypt.compareSync(candidate, hash);
		} catch {
			return false;
		}
	});
	if (index === -1) return { matched: false, remainingHashes: hashes };

	const remainingHashes = hashes.slice();
	remainingHashes.splice(index, 1);
	return { matched: true, remainingHashes };
}
