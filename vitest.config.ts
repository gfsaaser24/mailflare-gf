import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Mirrors the "@/*" -> "./src/*" mapping in tsconfig.json.
		alias: { "@": resolve(__dirname, "src") },
	},
	test: {
		environment: "node",
		globals: false,
		include: ["tests/**/*.test.ts"],
		fileParallelism: false, // DB-backed tests share one database
		setupFiles: ["./tests/setup.ts"],
		coverage: { provider: "v8", reportsDirectory: "coverage" },
	},
});
