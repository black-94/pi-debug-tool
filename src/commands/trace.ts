import { formatCount } from "../core/format";
import { flagNumber, type ParsedArgs } from "./args";
import { formatEventLine } from "./event-format";
import type { CommandDeps, Subcommand } from "./deps";

const SEPARATOR = "─".repeat(58);

export const runTrace: Subcommand = async (args, _ctx, deps) => {
	const action = (args.positionals[0] ?? "status").toLowerCase();
	const lines: string[] = [`pi-debug-tool — trace (${action})`, SEPARATOR];

	switch (action) {
		case "on":
			deps.runtime.trace.setEnabled(true);
			lines.push("Tracing enabled. Metadata-only events will be recorded in the in-memory ring buffer.");
			lines.push("No tool arguments/results, prompt text, thinking text, or image bytes are recorded.");
			break;
		case "off":
			deps.runtime.trace.setEnabled(false);
			lines.push("Tracing disabled. Existing ring-buffer entries are retained until /debug clear.");
			break;
		case "status":
			lines.push(...statusLines(deps));
			break;
		case "tail":
			lines.push(...tailLines(args, deps));
			break;
		default:
			lines.push(`unknown action "${action}". Use: on | off | status | tail`);
	}
	return { title: `/debug trace ${action}`, lines };
};

function statusLines(deps: CommandDeps): string[] {
	const trace = deps.runtime.trace;
	const metrics = trace.snapshotMetrics();
	const lines: string[] = [
		`state:     ${trace.isEnabled() ? "on" : "off"}`,
		`ring:      size=${formatCount(trace.ring.size)} capacity=${formatCount(trace.ring.capacity)} dropped=${formatCount(trace.ring.dropped)}`,
	];
	const observations = trace.getToolObservations();
	const inFlight = observations.filter((observation) => !observation.finished).length;
	lines.push(`toolCalls: observed=${formatCount(observations.length)} inFlight=${formatCount(inFlight)}`);
	const counters = Object.entries(metrics.events.counters).sort(([a], [b]) => a.localeCompare(b));
	if (counters.length === 0) {
		lines.push("counters:  (none yet; high-frequency events update these without filling the ring)");
	} else {
		lines.push(`counters:  ${counters.map(([name, count]) => `${name}=${count}`).join("  ")}`);
	}
	lines.push("note:      counters and tool durations are always maintained; ring entries only while tracing is on.");
	return lines;
}

function tailLines(args: ParsedArgs, deps: CommandDeps): string[] {
	const limit = flagNumber(args.flags, "limit", 30);
	const events = deps.runtime.trace.eventsLast(limit);
	if (events.length === 0) {
		return [
			deps.runtime.trace.isEnabled()
				? "No events recorded yet."
				: "Tracing is off. Enable it with /debug trace on.",
		];
	}
	const newestFirst = [...events].reverse();
	const lines = [`last ${newestFirst.length} event(s), newest first:`];
	for (const event of newestFirst) {
		lines.push(`  ${formatEventLine(event)}`);
	}
	return lines;
}
