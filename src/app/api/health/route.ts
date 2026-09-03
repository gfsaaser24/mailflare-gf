/**
 * Liveness only.
 *
 * Deliberately says nothing about the database, storage or configuration: the
 * container health check is reachable from anywhere that can reach the port, so
 * it must not become a free reconnaissance endpoint. Anything that needs real
 * diagnostics is behind authentication.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
	return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
