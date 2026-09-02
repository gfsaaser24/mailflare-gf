import { NextResponse } from "next/server";
import { withOrg } from "@/lib/api/with-org";
import { assertAdmin } from "@/lib/auth/admin";
import { getBranding, updateBranding } from "@/lib/branding/service";
import { getEnv } from "@/lib/cloudflare";
import { BRANDING_ICON_TYPES, isBrandingIcon, MAX_BRANDING_ICON_SIZE } from "./utils";

// Branding lives in `app_settings`, which is instance-level: there is no
// `organization_id` to scope. `withOrg` is used purely for authentication and
// the suspended-organisation check; the admin check is unchanged.
export async function GET() {
	return NextResponse.json(await getBranding(getEnv()), {
		headers: { "Cache-Control": "no-store" },
	});
}

export const PUT = withOrg(async ({ env, user }, request) => {
	try {
		assertAdmin(user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const form = await request.formData();
	const appName = String(form.get("appName") ?? "").trim();
	const iconValue = form.get("icon");
	if (!appName || appName.length > 60) {
		return NextResponse.json({ error: "App name must be between 1 and 60 characters" }, { status: 400 });
	}
	const icon = isBrandingIcon(iconValue) && iconValue.size > 0 ? iconValue : null;
	if (icon && !BRANDING_ICON_TYPES.includes(icon.type)) {
		return NextResponse.json({ error: "Use a PNG, JPEG, WebP, or GIF image" }, { status: 400 });
	}
	if (icon && icon.size > MAX_BRANDING_ICON_SIZE) {
		return NextResponse.json({ error: "Icon must be 2 MB or smaller" }, { status: 413 });
	}

	try {
		return NextResponse.json(await updateBranding(env, { appName, icon }));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to update branding";
		return NextResponse.json({ error: message }, { status: 500 });
	}
});
