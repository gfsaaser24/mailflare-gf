import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { hasAdminAccount } from "@/lib/auth/setup";
import { completeLogin } from "@/lib/auth/login-flow";
import { newId } from "@/lib/ids";
import { firstRunRegisterSchema } from "@/lib/validators";
import { attachOrProvisionDomainForUser } from "@/lib/domains/service";
import { DEFAULT_ORGANIZATION_ID } from "@/lib/organizations/constants";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";

export async function POST(request: Request) {
	const env = getEnv();
	const db = getDb(env);
	if (await hasAdminAccount(env)) {
		return NextResponse.json({ error: "Registration is closed after the first account is created" }, { status: 403 });
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid registration request" }, { status });
	}
	const firstRunParsed = firstRunRegisterSchema.safeParse(body);
	if (!firstRunParsed.success) {
		return NextResponse.json({ error: firstRunParsed.error.flatten() }, { status: 400 });
	}
	if (!(await verifyTurnstileToken(env, request, (body as Record<string, unknown>).turnstileToken))) {
		return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
	}

	const domainName = firstRunParsed.data.domain.toLowerCase().trim();
	const username = firstRunParsed.data.username.toLowerCase().trim();
	const email = `${username}@${domainName}`;
	const password = firstRunParsed.data.password;
	const name = username;

	const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
	if (existing) {
		return NextResponse.json({ error: "Email already registered" }, { status: 409 });
	}

	const userId = newId("usr");
	await db.insert(users).values({
		id: userId,
		email,
		resetEmail: firstRunParsed.data.resetEmail,
		passwordHash: hashPassword(password),
		name,
		role: "admin",
	});

	try {
		// Setup (`POST /api/setup/domain`) already provisioned this hostname on
		// Cloudflare. Reuse that work: attach the row, never provision twice.
		// First run: no organisation context exists yet, so the row lands in the
		// default organisation, exactly where the column default already put it.
		const domain = await attachOrProvisionDomainForUser(env, DEFAULT_ORGANIZATION_ID, userId, domainName, {
			enableRouting: true,
			enableSending: true,
		});
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, email);
		const mailboxId = newId("mbx");
		await db.insert(mailboxes).values({
			id: mailboxId,
			userId,
			domainId: domain.id,
			localPart: username,
			displayName: username,
		});
		await ensureMailboxDomainRouting(env, db, { id: mailboxId, domainId: domain.id, localPart: username, useAllDomains: true });
	} catch (err) {
		await db.delete(users).where(eq(users.id, userId));
		const message = err instanceof Error ? err.message : "Domain setup failed";
		return NextResponse.json({ error: message }, { status: 502 });
	}

	// First run: nobody can have TOTP yet, but the flow stays the same for everyone.
	return completeLogin(env, request, { id: userId, totpEnabledAt: null }, { method: "password" });
}
