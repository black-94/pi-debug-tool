import { formatCount } from "../core/format";
import type { Subcommand } from "./deps";

/** Clear only this extension's in-memory trace/metrics. Never touches the session. */
export const runClear: Subcommand = async (_args, _ctx, deps) => {
	const before = deps.runtime.trace.snapshotMetrics();
	const eventsBefore = deps.runtime.trace.ring.size;
	deps.runtime.trace.clear();
	return {
		title: "/debug clear",
		lines: [
			`cleared ${formatCount(eventsBefore)} ring event(s) and ${formatCount(before.tools.completed)} tool duration record(s).`,
			`tracing stays ${deps.runtime.trace.isEnabled() ? "on" : "off"}.`,
			"the session, transcript, model context, and MCP snapshot cache are untouched.",
		],
	};
};
