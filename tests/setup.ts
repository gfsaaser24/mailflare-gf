import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { closeTestDatabase, hasTestDatabase, truncateAll } from "./helpers/db";

/** Minimal .env loader: fills only the keys that are not already set. */
function loadEnvFile(file: string): void {
	let text: string;
	try {
		text = readFileSync(resolve(process.cwd(), file), "utf8");
	} catch {
		return;
	}
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

if (!process.env.TEST_DATABASE_URL) loadEnvFile(".env.local");

beforeAll(async () => {
	if (!hasTestDatabase()) return;
});

beforeEach(async () => {
	if (!hasTestDatabase()) return;
	await truncateAll();
});

afterAll(async () => {
	await closeTestDatabase();
});
