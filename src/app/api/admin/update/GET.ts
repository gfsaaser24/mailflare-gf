import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { getUpdateStatus } from "./utils";

export const GET = withOrg(async ({ env, user }) => {
  try {
    assertAdmin(user);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json(await getUpdateStatus(env));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not check for updates";
    const status = message.includes("must be configured") ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
});
