export function quoteImapString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseSearchUids(line: string): string[] {
	const match = line.match(/^\* SEARCH(?:\s+(.+))?$/i);
	if (!match?.[1]) return [];
	return match[1].trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
}

export function getLiteralLength(line: string): number | null {
	const match = line.match(/\{(\d+)\}$/);
	return match ? Number(match[1]) : null;
}

export function isTaggedCompletion(line: string, tag: string): boolean {
	return line.toUpperCase().startsWith(`${tag.toUpperCase()} `);
}

export function parseListMailboxName(line: string): string | null {
	const match = line.match(/^\* LIST\s+\([^\)]*\)\s+(?:"[^"]*"|NIL)\s+(.+)$/i);
	if (!match?.[1]) return null;
	const value = match[1].trim();
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return value || null;
}


/** A single result from `dns.promises.lookup(host, { all: true })`. */
export type ResolvedHostAddress = { address: string; family: number };

/** Injectable stand-in for `dns.promises.lookup(host, { all: true })` (tests pass a fake). */
export type HostLookup = (hostname: string) => Promise<ResolvedHostAddress[]>;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(value: string): number[] | null {
	const match = value.match(IPV4_PATTERN);
	if (!match) return null;
	const parts = match.slice(1, 5).map(Number);
	if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return parts;
}

/**
 * IPv4 space we refuse to connect to: unspecified/"this network" (0/8), RFC1918
 * (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16) and
 * carrier-grade NAT (100.64/10).
 */
function isPrivateIpv4(parts: number[]): boolean {
	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

/** Expands an IPv6 literal (with optional trailing IPv4 part) to its 16 bytes. */
function parseIpv6(value: string): number[] | null {
	let text = value.trim().toLowerCase();
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	const zone = text.indexOf("%");
	if (zone >= 0) text = text.slice(0, zone);
	if (!text.includes(":")) return null;

	let tail: number[] = [];
	const lastColon = text.lastIndexOf(":");
	const trailing = text.slice(lastColon + 1);
	if (trailing.includes(".")) {
		const v4 = parseIpv4(trailing);
		if (!v4) return null;
		tail = v4;
		text = text.slice(0, lastColon);
		// ":" is all that is left of "::1.2.3.4"; restore the compressor.
		if (text.endsWith(":")) text += ":";
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;
	const toGroups = (part: string): number[] | null => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const chunk of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
			const numeric = Number.parseInt(chunk, 16);
			groups.push((numeric >> 8) & 0xff, numeric & 0xff);
		}
		return groups;
	};

	const head = toGroups(halves[0] ?? "");
	if (!head) return null;
	if (halves.length === 1) {
		const bytes = [...head, ...tail];
		return bytes.length === 16 ? bytes : null;
	}
	const rest = toGroups(halves[1] ?? "");
	if (!rest) return null;
	const bytes = [...head, ...rest, ...tail];
	if (bytes.length > 16) return null;
	const padding = new Array(16 - bytes.length).fill(0);
	return [...head, ...padding, ...rest, ...tail];
}

/**
 * IPv6 space we refuse: unspecified (::), loopback (::1), unique-local (fc00::/7),
 * link-local (fe80::/10), and IPv4-mapped/compatible forms of any blocked IPv4.
 */
function isPrivateIpv6(bytes: number[]): boolean {
	const isZeroPrefix = bytes.slice(0, 10).every((byte) => byte === 0);
	if (isZeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff) {
		// ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume.
		return isPrivateIpv4(bytes.slice(12));
	}
	if (bytes.slice(0, 12).every((byte) => byte === 0)) {
		// :: , ::1 and the deprecated ::a.b.c.d IPv4-compatible form.
		const v4 = bytes.slice(12);
		if (v4.every((byte) => byte === 0)) return true;
		return isPrivateIpv4(v4);
	}
	const first = bytes[0] ?? 0;
	const second = bytes[1] ?? 0;
	if ((first & 0xfe) === 0xfc) return true; // fc00::/7
	if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10
	return false;
}

/** True when the literal IP address is loopback, private, link-local or unique-local. */
export function isPrivateIpAddress(address: string): boolean {
	const v4 = parseIpv4(address.trim());
	if (v4) return isPrivateIpv4(v4);
	const v6 = parseIpv6(address);
	if (v6) return isPrivateIpv6(v6);
	return false;
}

/** True when the value is a literal IPv4 or IPv6 address rather than a hostname. */
export function isIpLiteral(value: string): boolean {
	const text = value.trim();
	return parseIpv4(text) !== null || parseIpv6(text) !== null;
}

/**
 * Literal-only checks. Kept as its own export because it is cheap, synchronous and
 * catches the obvious cases before any DNS traffic happens.
 */
export function assertSafeImapHost(host: string): void {
	let value = host.trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	if (!value || value === "localhost" || value.endsWith(".local") || value.endsWith(".localhost")) {
		throw new Error("IMAP host is not allowed");
	}
	if (isPrivateIpAddress(value)) {
		throw new Error("Private IMAP hosts are not allowed");
	}
}

async function defaultHostLookup(hostname: string): Promise<ResolvedHostAddress[]> {
	const { promises: dns } = await import("node:dns");
	return dns.lookup(hostname, { all: true });
}

/**
 * Resolves an IMAP host and refuses it if *any* returned address points into private
 * space, so a DNS answer that mixes a public and an internal address can't be used to
 * reach the internal one. The caller connects to the returned address, which also closes
 * the DNS-rebinding window between this check and the connect.
 */
export async function resolveSafeImapHost(
	host: string,
	lookup: HostLookup = defaultHostLookup,
): Promise<{ address: string; family: 4 | 6 }> {
	assertSafeImapHost(host);

	let value = host.trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);

	if (isIpLiteral(value)) {
		// assertSafeImapHost already vetted it; no DNS round trip needed.
		return { address: value, family: parseIpv4(value) ? 4 : 6 };
	}

	let addresses: ResolvedHostAddress[];
	try {
		addresses = await lookup(value);
	} catch {
		throw new Error("IMAP host could not be resolved");
	}
	if (!addresses?.length) throw new Error("IMAP host could not be resolved");

	for (const entry of addresses) {
		if (!entry?.address || !isIpLiteral(entry.address) || isPrivateIpAddress(entry.address)) {
			throw new Error("Private IMAP hosts are not allowed");
		}
	}

	const first = addresses[0] as ResolvedHostAddress;
	return { address: first.address, family: parseIpv4(first.address.trim()) ? 4 : 6 };
}
