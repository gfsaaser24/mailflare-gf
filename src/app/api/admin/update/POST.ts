import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { dispatchUpdateWorkflow } from "./utils";

export const POST = withOrg(async ({ user }) => {
  try {
    assertAdmin(user);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // assume it's already passed
    // const status = await getUpdateStatus(env);
    // if (!status.available) {
    // 	return NextResponse.json({ error: "Mailflare is already up to date", ...status }, { status: 409 });
    // }

    const dispatch = await dispatchUpdateWorkflow();

    return NextResponse.json({ ok: true, ...dispatch }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not trigger the update workflow";
    const status = message.includes("must be configured") ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
});
