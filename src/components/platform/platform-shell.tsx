"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarHeader } from "@/components/sidebar-header";
import { SidebarProvider, useSidebar } from "@/components/sidebar-state";

const links = [{ href: "/platform", label: "Organisations", icon: Building2 }];

function PlatformNav({ operatorEmail }: { operatorEmail: string }) {
	const pathname = usePathname();
	const { minimal } = useSidebar();

	return (
		<nav className="flex min-h-full flex-col gap-1">
			<SidebarHeader href="/platform" label="Platform" />
			<div className="space-y-1">
				{links.map((link) => {
					const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
					const Icon = link.icon;
					return (
						<Link
							key={link.href}
							href={link.href}
							title={minimal ? link.label : undefined}
							className={cn(
								"flex h-9 items-center gap-3 rounded-r-full text-sm font-medium text-neutral-700 transition-colors hover:bg-blue-50",
								minimal ? "mx-auto w-10 justify-center rounded-full px-0" : "-ml-3 pl-6",
								active && "bg-blue-100 text-blue-900",
							)}
						>
							<Icon size={18} />
							{!minimal && <span className="flex-1">{link.label}</span>}
						</Link>
					);
				})}
			</div>
			<span className="flex-1" />
			<Link
				href="/inbox"
				title={minimal ? "Back to mail" : undefined}
				className={cn(
					"flex h-9 items-center gap-3 rounded-r-full text-sm font-medium text-neutral-500 transition-colors hover:bg-blue-50",
					minimal ? "mx-auto w-10 justify-center rounded-full px-0" : "-ml-3 pl-6",
				)}
			>
				<ArrowLeft size={18} />
				{!minimal && <span className="flex-1">Back to mail</span>}
			</Link>
			{!minimal && (
				<p className="truncate px-3 pt-2 text-[11px] text-neutral-400">{operatorEmail}</p>
			)}
		</nav>
	);
}

/**
 * Same chrome as `(admin)`, minus the mailbox/compose providers: the platform
 * plane has no mailbox of its own to act on.
 */
export function PlatformShell({
	children,
	operatorEmail,
}: {
	children: React.ReactNode;
	operatorEmail: string;
}) {
	return (
		<SidebarProvider expandedWidth={256}>
			<div className="grid h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] duration-200">
				<aside className="min-h-0 overflow-y-auto overscroll-contain px-3 py-4 scrollbar-gutter-stable">
					<PlatformNav operatorEmail={operatorEmail} />
				</aside>
				<div className="flex min-h-0 min-w-0 flex-col">
					<main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-tl-3xl px-6 py-10 scrollbar-gutter-stable lg:px-12">
						<div className="w-full max-w-4xl">{children}</div>
					</main>
				</div>
			</div>
		</SidebarProvider>
	);
}
