import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DebugRuntime } from "../runtime";
import { notifyLine, presentReport, type DebugReport } from "../ui/present";
import { parseArgs, type ParsedArgs } from "./args";
import { runClear } from "./clear";
import { runContext } from "./context";
import { runDoctor } from "./doctor";
import { runExport } from "./export";
import { runHelp } from "./help";
import { runMcp } from "./mcp";
import { runResources } from "./resources";
import { runStats } from "./stats";
import { runStatus } from "./status";
import { runTimeline } from "./timeline";
import { runTrace } from "./trace";
import type { CommandDeps, Subcommand } from "./deps";

const SUBCOMMANDS: Array<{ name: string; hint: string }> = [
	{ name: "status", hint: "session/model/context/branch + summary" },
	{ name: "mcp", hint: "overview | tools | calls | doctor [server] [--limit N]" },
	{ name: "resources", hint: "tools | commands | skills | mcp" },
	{ name: "context", hint: "summary | sections | messages" },
	{ name: "trace", hint: "on | off | status | tail" },
	{ name: "timeline", hint: "run/turn/toolCall text timeline" },
	{ name: "stats", hint: "session | tools | cache | context | errors" },
	{ name: "doctor", hint: "conservative diagnostics" },
	{ name: "export", hint: "jsonl | markdown [path]" },
	{ name: "clear", hint: "clear trace/metrics only" },
	{ name: "help", hint: "show usage" },
];

const ROUTES: Record<string, Subcommand> = {
	status: runStatus,
	mcp: runMcp,
	resources: runResources,
	context: runContext,
	trace: runTrace,
	timeline: runTimeline,
	stats: runStats,
	doctor: runDoctor,
	export: runExport,
	clear: runClear,
	help: runHelp,
};

const MCP_TOPICS = ["overview", "tools", "calls", "doctor"];

/** Structural match for Pi's AutocompleteItem (not re-exported by pi-coding-agent). */
interface CommandSuggestion {
	value: string;
	label: string;
}

export function getDebugArgumentCompletions(prefix: string): CommandSuggestion[] | null {
	if (prefix.startsWith("--")) {
		const flags = ["--detail", "--limit", "--force", "--server"];
		const matches = flags.filter((flag) => flag.startsWith(prefix));
		return matches.length > 0 ? matches.map((flag) => ({ value: flag, label: flag })) : null;
	}
	const mcpMatch = /^mcp\s+(\S*)$/.exec(prefix);
	if (mcpMatch) {
		const fragment = mcpMatch[1] ?? "";
		const topics = MCP_TOPICS.filter((topic) => topic.startsWith(fragment));
		return topics.length > 0 ? topics.map((topic) => ({ value: `mcp ${topic}`, label: `mcp ${topic}` })) : null;
	}
	const matches = SUBCOMMANDS.filter((entry) => entry.name.startsWith(prefix));
	return matches.length > 0
		? matches.map((entry) => ({ value: entry.name, label: `${entry.name} — ${entry.hint}` }))
		: null;
}

/**
 * Build the `/debug` command handler.
 *
 * The handler only reads public state and renders to the UI (or, for `export`,
 * writes a user-requested file). It never triggers an agent turn.
 */
export function createDebugHandler(
	pi: ExtensionAPI,
	runtime: DebugRuntime,
): (rawArgs: string, ctx: ExtensionCommandContext) => Promise<void> {
	return async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
		try {
			const parsed = parseArgs(rawArgs);
			const subcommand = (parsed.positionals[0] ?? "status").toLowerCase();
			const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };
			const report = await dispatch(subcommand, rest, ctx, { pi, runtime });
			await presentReport(ctx, report);
		} catch (error) {
			runtime.trace.metrics.noteInternalError();
			const message = error instanceof Error ? error.message : String(error);
			notifyLine(ctx, `debug command failed (swallowed): ${message}`, "error");
		}
	};
}

async function dispatch(
	subcommand: string,
	args: ParsedArgs,
	ctx: ExtensionCommandContext,
	deps: CommandDeps,
): Promise<DebugReport> {
	const route = ROUTES[subcommand];
	if (!route) {
		return {
			title: "/debug",
			lines: [
				`unknown subcommand "${subcommand}".`,
				`available: ${SUBCOMMANDS.map((entry) => entry.name).join(", ")}`,
				"run /debug help for full usage.",
			],
		};
	}
	return route(args, ctx, deps);
}
