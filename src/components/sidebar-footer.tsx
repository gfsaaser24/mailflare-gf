import packageJson from "../../package.json";
import { useSidebar } from "./sidebar-state";

export function SidebarFooter() {
	const { minimal } = useSidebar();
	if (minimal) return null;
	// Version only. The upstream marketing link that used to live here also put
	// this instance's hostname in the URL, so it went with the landing page.
	return <p className="px-3 pt-3 text-xs text-neutral-400">v{packageJson.version}</p>;
}
