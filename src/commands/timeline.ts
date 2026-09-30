import type { TraceEvent } from "../core/types";
import { formatEventLine } from "./event-format";
import { flagNumber } from "./args";
import type { Subcommand } from "./deps";

const SEPARATOR = "─".repeat(58);

export const runTimeline: Subcommand = async (args, _ctx, deps) => {
	const limit = flagNumber(args.flags, "limit", 500);
	const all = deps.runtime.trace.events();
	const events = all.length > limit ? all.slice(all.length - limit) : all;
	const lines: string[] = [`pi-debug-tool — timeline (last ${events.length} of ${all.length} events)`, SEPARATOR];

	if (events.length === 0) {
		lines.push(
			deps.runtime.trace.isEnabled()
				? "No events recorded yet. Run some agent activity, then retry."
				: "Tracing is off, so the ring buffer is empty. Enable it with /debug trace on.",
		);
		return { title: "/debug timeline", lines };
	}

	const baseMono = events[0]?.monoTime ?? 0;
	let currentRunKey: string | undefined;
	let currentTurnKey: string | undefined;
	let runStartMono = baseMono;

	for (const event of events) {
		const runKey = event.runId === undefined ? "session" : String(event.runId);
		const turnKey = event.turnIndex === undefined ? "-" : String(event.turnIndex);

		if (runKey !== currentRunKey) {
			lines.push("");
			lines.push(`run ${runKey}`);
			currentRunKey = runKey;
			currentTurnKey = undefined;
			runStartMono = event.monoTime;
		}
		if (turnKey !== currentTurnKey) {
			lines.push(`  turn ${turnKey}`);
			currentTurnKey = turnKey;
		}
		lines.push(`    ${formatEventLine(event, runStartMono)}`);
	}

	lines.push(SEPARATOR);
	lines.push("Correlation: run/turn are local counters; tool= is Pi's native toolCallId (shortened).");
	lines.push("Parallel tool calls appear interleaved by monotonic time but keep distinct tool ids.");
	return { title: "/debug timeline", lines };
};

/** Group events by run/turn for reuse by stats/doctor. */
export function groupByRunTurn(events: TraceEvent[]): Map<string, Map<string, TraceEvent[]>> {
	const grouped = new Map<string, Map<string, TraceEvent[]>>();
	for (const event of events) {
		const runKey = event.runId === undefined ? "session" : String(event.runId);
		const turnKey = event.turnIndex === undefined ? "-" : String(event.turnIndex);
		let turns = grouped.get(runKey);
		if (!turns) {
			turns = new Map();
			grouped.set(runKey, turns);
		}
		const list = turns.get(turnKey);
		if (list) list.push(event);
		else turns.set(turnKey, [event]);
	}
	return grouped;
}
