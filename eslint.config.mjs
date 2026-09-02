// eslint-config-next 16 ships flat configs, so they are imported directly.
// (`FlatCompat` used to wrap them and crashes on this version.)
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import requireOrgScope from "./eslint-rules/require-org-scope.js";

const eslintConfig = [
	...nextCoreWebVitals,
	...nextTypescript,
	{
		// Tenant routes only. `platform`, `edge`, `setup`, `auth` and `admin` run
		// outside (or across) organisation scope by design.
		files: ["src/app/api/**/*.ts"],
		ignores: [
			"src/app/api/platform/**",
			"src/app/api/edge/**",
			"src/app/api/setup/**",
			"src/app/api/auth/**",
			"src/app/api/admin/**",
		],
		plugins: {
			mailflare: { rules: { "require-org-scope": requireOrgScope } },
		},
		rules: {
			// TODO(T3.2): flip to "error" once every route folder has been converted
			// to withOrg(); it is a warning while the migration is in flight.
			"mailflare/require-org-scope": "error",
		},
	},
];

export default eslintConfig;
