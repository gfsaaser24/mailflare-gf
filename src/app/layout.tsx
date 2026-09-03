import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

/**
 * Every HTML document must be rendered per request. The CSP built in
 * `src/proxy.ts` uses a per-request nonce + `'strict-dynamic'`, and Next can
 * only stamp that nonce onto its own inline bootstrap scripts
 * (`self.__next_f.push(...)`) while it is rendering *for a request*. A
 * prerendered page would ship those scripts nonce-less at build time and the
 * browser would block them, which takes the whole app down.
 *
 * Declaring it on the root layout covers every route group; `next build` must
 * report zero `○ (Static)` pages.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Mailflare",
	description: "Multi-tenant email on Cloudflare",
	icons: { icon: "/api/branding/icon" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<head>
				<link rel="icon" href="/api/branding/icon"></link>
			</head>
			<body className={`${geistSans.variable} ${geistMono.variable} antialiased light`}>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
