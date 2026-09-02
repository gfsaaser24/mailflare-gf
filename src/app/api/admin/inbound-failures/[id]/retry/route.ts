import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { retryInboundFailure } from "@/lib/inbound-failures/service";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertAdmin(user);
		const { id } = await params;
		const result = await retryInboundFailure(env, id);
		if (result.status === "not_found") {
			return NextResponse.json({ error: "Inbound failure not found" }, { status: 404 });
		}
		if (result.status === "failed") {
			return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
		}
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}
