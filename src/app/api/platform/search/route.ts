/**
 * `GET /api/platform/search?q=` — mailboxes and domains across every
 * organisation. Platform plane (T3.3): `requirePlatformOperator`, never
 * `withOrg`.
 */
import { NextResponse } from "next/server";
import { requirePlatformOperator } from "@/lib/platform/guard";
import { searchPlatform } from "@/lib/platform/service";

export async function GET(request: Request) {
	const guard = await requirePlatformOperator(request);
	if (guard instanceof Response) return guard;

	const query = new URL(request.url).searchParams.get("q") ?? "";
	const results = await searchPlatform(guard.db, query);
	return NextResponse.json({ results });
}
