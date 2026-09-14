/**
 * Outbound recipient lists (`to`, `cc`, `bcc`).
 *
 * A recipient field arrives either as an array of addresses or as one
 * comma/semicolon separated string, because the composer posts a plain text
 * field while the v1 API accepts both. Everything downstream works on a
 * trimmed `string[]`, and the stored column is that list comma-joined.
 *
 * Addresses keep their display name (`"Chen, Maya" <maya@example.com>`), so the
 * splitter has to respect quotes and angle brackets: a comma inside either is
 * not a separator.
 */

/** Cloudflare's `send_email` binding accepts at most 50 `to` + `cc` + `bcc`. */
export const MAX_RECIPIENTS = 50;

/**
 * Deliberately loose: RFC 5322 allows far more than this, and the transport is
 * the real authority. This only rejects input that is obviously not an address.
 */
const EMAIL_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;".]+(?:\.[^\s@<>,;".]+)+$/;

/** Splits an address list on `,`/`;` outside quoted display names and `<...>`. */
export function splitAddressList(value: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inQuotes = false;
	let inAngle = false;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (inQuotes) {
			if (char === "\\" && i + 1 < value.length) {
				current += char + value[++i];
				continue;
			}
			if (char === '"') inQuotes = false;
			current += char;
			continue;
		}
		if (char === '"') {
			inQuotes = true;
			current += char;
			continue;
		}
		if (char === "<") inAngle = true;
		else if (char === ">") inAngle = false;
		else if (!inAngle && (char === "," || char === ";")) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);

	return parts.map((part) => part.trim()).filter(Boolean);
}

/** Any accepted recipient input, flattened to trimmed, non-empty addresses. */
export function normalizeRecipients(value: string | string[] | null | undefined): string[] {
	if (value == null) return [];
	const items = Array.isArray(value) ? value : [value];
	return items.flatMap((item) => (typeof item === "string" ? splitAddressList(item) : []));
}

/** `"Maya Chen" <maya@example.com>` -> `maya@example.com`; a bare address is returned as is. */
export function getAddressPart(value: string): string {
	const match = value.match(/<([^<>]*)>\s*$/);
	return (match ? match[1] : value).trim();
}

export function isEmailLikeAddress(value: string): boolean {
	return EMAIL_PATTERN.test(getAddressPart(value));
}

/** The stored `to_addr` / `cc_addr` / `bcc_addr` form, or null when empty. */
export function joinRecipients(addresses: string[]): string | null {
	return addresses.length ? addresses.join(", ") : null;
}

/** Case-insensitive dedupe on the address part, keeping the first spelling. */
export function dedupeRecipients(addresses: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const address of addresses) {
		const key = getAddressPart(address).toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(address);
	}
	return unique;
}
