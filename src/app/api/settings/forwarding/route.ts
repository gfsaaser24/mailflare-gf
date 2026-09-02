import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { users } from "@/db/schema";
import { withOrg } from "@/lib/api/with-org";
import type { UpdateForwardingEmailInput } from "./types";
import { parseUpdateForwardingEmailRequest } from "./utils";

export const PATCH = withOrg(async ({ db, user, scoped }, request) => {
	let input: UpdateForwardingEmailInput;
	try {
		input = await parseUpdateForwardingEmailRequest(request);
	} catch (error) {
		if (error instanceof ZodError) {
			return NextResponse.json({ error: error.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	await db
		.update(users)
		.set({ forwardingEmail: input.forwardingEmail })
		.where(and(scoped(users), eq(users.id, user.id)));

	return NextResponse.json({ forwardingEmail: input.forwardingEmail });
});
