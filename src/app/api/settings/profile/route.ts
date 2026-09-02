import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import type { UpdateProfileInput } from "./types";
import { parseUpdateProfileRequest } from "./utils";

export const PATCH = withOrg(async ({ db, user, scoped }, request) => {
	let parsed: UpdateProfileInput;
	try {
		parsed = await parseUpdateProfileRequest(request);
	} catch (err) {
		if (err instanceof ZodError) {
			return NextResponse.json({ error: err.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	const forwardingEmail =
		parsed.forwardingEmail === undefined ? user.forwardingEmail : parsed.forwardingEmail;
	await db
		.update(users)
		.set({
			name: parsed.name,
			resetEmail: parsed.resetEmail,
			forwardingEmail,
		})
		.where(and(scoped(users), eq(users.id, user.id)));

	return NextResponse.json({
		user: {
			id: user.id,
			email: user.email,
			name: parsed.name,
			resetEmail: parsed.resetEmail,
			forwardingEmail,
			canForwardEmail: true,
		},
	});
});
