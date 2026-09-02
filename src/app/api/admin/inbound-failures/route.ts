import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { listInboundFailures } from "@/lib/inbound-failures/service";

export async function GET(request: Request) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertAdmin(user);
		const includeResolved = new URL(request.url).searchParams.get("includeResolved") === "true";
		const failures = await listInboundFailures(env, { includeResolved });
		return NextResponse.json({ failures });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}
