import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import {
	getAccountForwardingDestination,
	MAILFLARE_FORWARDED_HEADER,
} from "@/lib/email/account-forwarding";
import { processInboundMessage, storeRawToR2 } from "@/lib/email/inbound";
import { resolveInboundAddress } from "@/lib/email/routing";

/**
 * Inbound mail relayed by the thin Cloudflare edge worker (cloudflare-worker/).
 * The body is the raw RFC822 message; envelope data arrives in X-Mail-* headers.
 */
export async function POST(request: Request) {
	const env = getEnv();
	if (!isAuthorized(request, env.EDGE_WORKER_SECRET)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const from = request.headers.get("X-Mail-From") ?? "";
	const to = request.headers.get("X-Mail-To") ?? "";
	if (!to) {
		return NextResponse.json({ error: "Missing X-Mail-To" }, { status: 400 });
	}
	const headers = parseMailHeaders(request.headers.get("X-Mail-Headers"));

	const decision = await resolveInboundAddress(getDb(env), to);
	if (!decision?.mailbox || decision.action !== "store") {
		return NextResponse.json({ error: "Unknown recipient" }, { status: 404 });
	}

	const raw = await request.arrayBuffer();
	const rawR2Key = await storeRawToR2(env, from, to, raw);

	try {
		await processInboundMessage(env, { from, to, rawR2Key, headers });
	} catch (error) {
		// The raw message is already stored, so never bounce here: reprocessing is possible.
		console.error(`Inbound processing failed for ${to} (raw ${rawR2Key})`, error);
	}

	let forwardTo: string | undefined;
	if (!hasForwardedFlag(headers)) {
		try {
			forwardTo = (await getAccountForwardingDestination(env, to)) ?? undefined;
		} catch (error) {
			console.error(`Forwarding lookup failed for ${to}`, error);
		}
	}

	return NextResponse.json({ ok: true, forwardTo });
}

function parseMailHeaders(value: string | null): Record<string, string> {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
		);
	} catch {
		return {};
	}
}

function hasForwardedFlag(headers: Record<string, string>): boolean {
	const flag = MAILFLARE_FORWARDED_HEADER.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === flag);
}

function isAuthorized(request: Request, secret: string | undefined): boolean {
	if (!secret) return false;
	const header = request.headers.get("Authorization") ?? "";
	if (!header.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(secret);
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}
