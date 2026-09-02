/**
 * `POST /api/invites/[token]/accept` — set the password behind an invite (T3.5).
 *
 * Public (the user has no session yet) and rate-limited on the same limiter as
 * login, because a token guess is a credential guess. Accepting revokes every
 * session the account still holds, so the user signs in fresh afterwards.
 */
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { acceptInvite } from "@/lib/accounts/service";
import { recordAuthActivity } from "@/lib/auth/activity";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { acceptInviteSchema } from "@/lib/validators";

type InviteRouteParams = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: InviteRouteParams) {
	const env = getEnv();
	const { token } = await params;

	if (!(await allowLoginAttempt(env, request))) {
		return NextResponse.json(
			{ error: "Too many attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}
	const parsed = acceptInviteSchema.safeParse(body);
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const result = await acceptInvite(getDb(env), token, parsed.data.password);
	if (!result.ok) {
		return NextResponse.json({ error: "This invite link is no longer valid" }, { status: 404 });
	}

	await recordAuthActivity(env, {
		action: "auth.invite_accepted",
		userId: result.userId,
		request,
	});

	const response = NextResponse.json({ ok: true, email: result.email, redirect: "/login" });
	response.headers.set("Cache-Control", "no-store");
	return response;
}
