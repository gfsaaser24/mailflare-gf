import { connect as netConnect, type Socket as NetSocket } from "node:net";
import { Readable, Writable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { ImapImportInput } from "./imap-types";
import {
	getLiteralLength,
	isTaggedCompletion,
	parseListMailboxName,
	parseSearchUids,
	quoteImapString,
	resolveSafeImapHost,
	isIpLiteral,
} from "./imap-utils";
import type { ImportMessageInput } from "./types";

type ImapSocket = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close: () => Promise<void>;
};

function toImapSocket(socket: NetSocket): ImapSocket {
	return {
		readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
		writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
		close: () =>
			new Promise<void>((resolve) => {
				// A peer-closed socket already emitted its single "close"; don't wait for another.
				if (socket.destroyed) return resolve();
				socket.once("close", () => resolve());
				socket.destroy();
			}),
	};
}

/** Idle limit for the IMAP socket: a server that accepts the connection but never talks gets dropped. */
const IMAP_SOCKET_TIMEOUT_MS = 60_000;

function applySocketTimeout(socket: NetSocket): void {
	socket.setTimeout(IMAP_SOCKET_TIMEOUT_MS, () => {
		socket.destroy(new Error("IMAP connection timed out"));
	});
}

/**
 * Connects to `address`, the value already vetted by `resolveSafeImapHost`, never to the
 * hostname: re-resolving here would let DNS hand back a private address after the check.
 * `hostname` is only used for TLS SNI and certificate validation.
 */
async function connectImapSocket(input: {
	hostname: string;
	address: string;
	family: 4 | 6;
	port: number;
	secure: boolean;
}): Promise<ImapSocket> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		// SNI must be a name; an IP literal there is rejected by TLS.
		const servername = isIpLiteral(input.hostname) ? undefined : input.hostname;

		if (input.secure) {
			const socket = tlsConnect(
				// No `family` here: `host` is already a literal IP, so TLS does no DNS.
				{
					host: input.address,
					port: input.port,
					...(servername ? { servername } : {}),
				},
				() => {
					socket.off("error", onError);
					resolve(toImapSocket(socket));
				},
			);
			applySocketTimeout(socket);
			socket.once("error", onError);
			return;
		}

		const socket = netConnect(
			{ host: input.address, port: input.port, family: input.family },
			() => {
				socket.off("error", onError);
				resolve(toImapSocket(socket));
			},
		);
		applySocketTimeout(socket);
		socket.once("error", onError);
	});
}

class ImapConnection {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private decoder = new TextDecoder();
	private encoder = new TextEncoder();
	private buffer = new Uint8Array();
	private tagCounter = 0;
	private socket: ImapSocket;

	constructor(socket: ImapSocket) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
	}

	async close(): Promise<void> {
		try {
			await this.writer.close();
		} catch {
			// Socket may already be closed by the server.
		}
		try {
			await this.socket.close();
		} catch {
			// Socket may already be closed by the server.
		}
	}

	async readGreeting(): Promise<void> {
		const line = await this.readLine();
		if (!line.startsWith("* OK")) throw new Error("IMAP server did not send an OK greeting");
	}

	async command(command: string): Promise<string[]> {
		const tag = this.nextTag();
		await this.write(`${tag} ${command}\r\n`);
		const lines: string[] = [];
		while (true) {
			const line = await this.readLine();
			lines.push(line);
			if (isTaggedCompletion(line, tag)) {
				if (!line.toUpperCase().includes(" OK")) {
					throw new Error(`IMAP command failed: ${line}`);
				}
				return lines;
			}
		}
	}

	async fetchMessage(uid: string): Promise<ArrayBuffer> {
		const tag = this.nextTag();
		await this.write(`${tag} UID FETCH ${uid} (RFC822)\r\n`);
		let raw: ArrayBuffer | null = null;

		while (true) {
			const line = await this.readLine();
			const literalLength = getLiteralLength(line);
			if (literalLength !== null) {
				raw = await this.readBytes(literalLength);
				continue;
			}
			if (isTaggedCompletion(line, tag)) {
				if (!line.toUpperCase().includes(" OK")) {
					throw new Error(`IMAP fetch failed: ${line}`);
				}
				if (!raw) throw new Error("IMAP fetch returned no message");
				return raw;
			}
		}
	}

	private nextTag(): string {
		this.tagCounter += 1;
		return `A${String(this.tagCounter).padStart(4, "0")}`;
	}

	private async write(value: string): Promise<void> {
		await this.writer.write(this.encoder.encode(value));
	}

	private async readLine(): Promise<string> {
		while (true) {
			const index = findCrlf(this.buffer);
			if (index >= 0) {
				const lineBytes = this.buffer.slice(0, index);
				this.buffer = this.buffer.slice(index + 2);
				return this.decoder.decode(lineBytes);
			}
			await this.readMore();
		}
	}

	private async readBytes(length: number): Promise<ArrayBuffer> {
		while (this.buffer.byteLength < length) {
			await this.readMore();
		}
		const bytes = this.buffer.slice(0, length);
		this.buffer = this.buffer.slice(length);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	private async readMore(): Promise<void> {
		const { value, done } = await this.reader.read();
		if (done || !value) throw new Error("IMAP connection closed unexpectedly");
		const next = new Uint8Array(this.buffer.byteLength + value.byteLength);
		next.set(this.buffer);
		next.set(value, this.buffer.byteLength);
		this.buffer = next;
	}
}

function findCrlf(buffer: Uint8Array): number {
	for (let index = 0; index < buffer.byteLength - 1; index += 1) {
		if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
	}
	return -1;
}

export async function fetchImapMessages(input: ImapImportInput): Promise<ImportMessageInput[]> {
	const resolved = await resolveSafeImapHost(input.host);
	const socket = await connectImapSocket({
		hostname: input.host.trim(),
		address: resolved.address,
		family: resolved.family,
		port: input.port,
		secure: input.secure,
	});
	const imap = new ImapConnection(socket);
	try {
		await imap.readGreeting();
		await imap.command(`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`);
		await imap.command(`SELECT ${quoteImapString(input.folder)}`);
		const searchLines = await imap.command("UID SEARCH ALL");
		const uids = searchLines.flatMap(parseSearchUids).slice(-input.limit);
		const messages: ImportMessageInput[] = [];
		for (const uid of uids) {
			messages.push({
				filename: `${input.folder}-${uid}.eml`,
				raw: await imap.fetchMessage(uid),
			});
		}
		await imap.command("LOGOUT").catch(() => undefined);
		return messages;
	} finally {
		await imap.close();
	}
}

export async function listImapFolders(input: Omit<ImapImportInput, "folder" | "limit">): Promise<string[]> {
	const resolved = await resolveSafeImapHost(input.host);
	const socket = await connectImapSocket({
		hostname: input.host.trim(),
		address: resolved.address,
		family: resolved.family,
		port: input.port,
		secure: input.secure,
	});
	const imap = new ImapConnection(socket);
	try {
		await imap.readGreeting();
		await imap.command(`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`);
		const lines = await imap.command('LIST "" "*"');
		await imap.command("LOGOUT").catch(() => undefined);
		return Array.from(new Set(lines.map(parseListMailboxName).filter((name): name is string => !!name)));
	} finally {
		await imap.close();
	}
}
