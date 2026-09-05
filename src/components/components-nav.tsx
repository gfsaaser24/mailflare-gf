import Link from "next/link";
import type { DragEvent, MouseEvent } from "react";
import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { usePathname, useRouter } from "next/navigation";
import { getMessageDragData } from "@/lib/messages/drag-utils";
import { useSelectedMailbox } from "./mailbox-provider";
import { RouteProgress } from "./route-progress";
import { useSidebar } from "./sidebar-state";
import { useCompose } from "./compose/compose-context";
import { preloadMailboxPage } from "./components-nav-utils";
import type { NavLink } from "./components-nav-types";

export function NavItem({ link }: { link: NavLink }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { openComposer } = useCompose();
  const { selectedMailbox } = useSelectedMailbox();
  const { minimal } = useSidebar();
  const [dragOver, setDragOver] = useState(false);
  const [navigating, startNavigation] = useTransition();

  if (!link.href) {
    return <span className="flex-1" />;
  }

  const Icon = link.icon;
  if (!Icon) return null;
  const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
  const classes = cn(
    "flex h-9 items-center gap-3 rounded-r-full text-sm font-medium text-neutral-700 transition-colors hover:bg-blue-50",
    minimal && "relative mx-auto w-10 justify-center rounded-full px-0",
    active && "bg-blue-100 text-blue-900",
    dragOver && "bg-blue-50 text-blue-900 ring-1 ring-blue-200",
    link.primary &&
      "mb-3 h-12 w-fit rounded-2xl bg-blue-100 px-5 text-blue-950 shadow-sm hover:bg-blue-200",
    link.primary && minimal && "h-11 w-11 rounded-2xl px-0",
  );
  const dropProps = link.onMessageDrop
    ? {
        onDragOver: (event: DragEvent) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (event: DragEvent) => {
          const payload = getMessageDragData(event.dataTransfer);
          setDragOver(false);
          if (!payload) return;
          event.preventDefault();
          link.onMessageDrop?.(payload.messageIds);
        },
      }
    : {};

  if (link.href === "/compose") {
    return (
      <button
        type="button"
        onClick={openComposer}
        className={classes}
        title={minimal ? link.label : undefined}
        {...dropProps}
      >
        <Icon
        size={21}
          style={{ color: link.iconColor }}
        />
        {!minimal && <span className="flex-1">{link.label}</span>}
        {!minimal && typeof link.count === "number" && link.count > 0 && (
          <span className="ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
        {minimal && typeof link.count === "number" && link.count > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
      </button>
    );
  }

  /** Hover/focus warms both halves of the next screen: RSC payload and list data. */
  function prefetch() {
    if (!link.preloadMessages || active) return;
    router.prefetch(link.href!);
    preloadMailboxPage(queryClient, link.href!, selectedMailbox?.id);
  }

  /**
   * Plain left clicks navigate inside a transition, which keeps the current
   * folder on screen (and its scroll position) until the next one is ready.
   * Modified clicks fall through to the `<Link>` so open-in-new-tab still works.
   */
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (
      !link.preloadMessages ||
      active ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    preloadMailboxPage(queryClient, link.href!, selectedMailbox?.id);
    startNavigation(() => {
      router.push(link.href!);
    });
  }

  return (
    <>
      <RouteProgress active={navigating} />
      <Link
        href={link.href}
        onClick={navigate}
        onMouseEnter={prefetch}
        onFocus={prefetch}
        title={minimal ? link.label : undefined}
        className={cn(!minimal && "-ml-3 pl-6", classes)}
        {...dropProps}
      >
        <Icon
          // className={minimal ? "h-4 w-4" : "h-5 w-5"}
          style={{ color: link.iconColor }}
          size={18}
        />
        {!minimal && <span className="flex-1">{link.label}</span>}
        {!minimal && typeof link.count === "number" && link.count > 0 && (
          <span className="ml-auto mr-3 rounded-full px-2 py-0.5 text-sm font-semibold text-neutral-700">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
        {minimal && typeof link.count === "number" && link.count > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {link.count > 99 ? "99+" : link.count}
          </span>
        )}
      </Link>
    </>
  );
}
