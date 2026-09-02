"use client";

import { usePathname } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { DashboardNav } from "@/components/dashboard-nav";
import { ImpersonationBanner } from "@/components/platform/impersonation-banner";

const adminPrefixes = ["/admin", "/mailboxes", "/domains", "/api-keys", "/activity", "/audit-logs", "/webhooks", "/branding"];

export function DashboardShellNav() {
	const pathname = usePathname();
	const isAdmin = adminPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

	return (
		<>
			{/* Renders nothing unless the session was minted by an operator (T3.3). */}
			<ImpersonationBanner />
			{isAdmin ? <AdminNav /> : <DashboardNav />}
		</>
	);
}
