import type { NextConfig } from "next";
import { getSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
	output: "standalone",
	turbopack: {
		root: import.meta.dirname,
	},
	allowedDevOrigins: ["mail.dev"],
	serverExternalPackages: ["postgres", "@aws-sdk/client-s3"],
	typescript: {
		ignoreBuildErrors: true,
	},
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: getSecurityHeaders(),
			},
		];
	},
};

export default nextConfig;
