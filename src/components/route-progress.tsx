"use client";

import { useEffect, useState } from "react";

/**
 * A 2 px bar pinned to the top of the viewport, shown while a folder switch or
 * a list refetch is in flight.
 *
 * It replaces the full-screen `LoadingTransition` overlay for navigation: the
 * previous list stays on screen and only this bar says "working". The width
 * only ever moves from an interval callback, and resets on cleanup, so the
 * component never sets state synchronously while rendering or in an effect body.
 */
export function RouteProgress({ active }: { active: boolean }) {
	const [progress, setProgress] = useState(0);

	useEffect(() => {
		if (!active) return;

		const timer = window.setInterval(() => {
			setProgress((current) => Math.min(92, current + Math.max(2, (92 - current) * 0.12)));
		}, 90);

		return () => {
			window.clearInterval(timer);
			setProgress(0);
		};
	}, [active]);

	if (!active) return null;

	return (
		<div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[120] h-0.5 bg-blue-100">
			<div
				className="h-full bg-blue-600 transition-[width] duration-150 ease-out"
				style={{ width: `${Math.max(8, progress)}%` }}
			/>
		</div>
	);
}
