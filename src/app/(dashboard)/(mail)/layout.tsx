/**
 * The mail folders (inbox, starred, snoozed, sent, drafts, archived, spam,
 * trash and custom folders) live under this group for one reason: it owns the
 * segment that `(dashboard)/loading.tsx` suspends on.
 *
 * With every folder nested here, switching inbox -> spam changes a child of
 * *this* layout, not a child of `(dashboard)`, so the full list skeleton no
 * longer flashes on each switch. There is deliberately no `loading.tsx` in this
 * group: with no boundary, React keeps the current folder painted until the
 * next one is ready (`startTransition` in the sidebar), and the 2 px
 * `RouteProgress` bar is the only "working" signal.
 *
 * `/calendar`, `/rules`, `/compose` and `/import-export` stay outside the group
 * and keep the skeleton.
 */
export default function MailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
