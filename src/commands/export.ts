import { mkdir, lstat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
	summarizeCommands,
	summarizeProjection,
	summarizeSkills,
	summarizeSystemPromptOptions,
	summarizeTools,
} from "../core/inspectors";
import { computeSessionMetrics } from "../core/session-metrics";
import { sanitizeValue } from "../core/redaction";
import { formatBytes, formatCount, formatCost, formatPercent } from "../core/format";
import { readInventory, readRegisteredServers, type RegisteredServerInfo } from "./mcp";import { flagBool } from "./args";
import { safe, type CommandDeps, type Subcommand } from "./deps";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { McpCallSummary, McpToolInventory } from "../core/mcp-native";
import type { MetricsSnapshot, SessionMetrics, TraceEvent } from "../core/types";

interface McpExport {
	inventory: McpToolInventory | { unavailable: string };
	registeredServers: RegisteredServerInfo[] | { unavailable: string };
	calls: McpCallSummary;
}

interface ExportData {
	meta: { tool: string; version: string; exportedAt: string; observerOnly: true };
	trace: TraceEvent[];
	metrics: MetricsSnapshot;
	session: SessionMetrics | { unavailable: string };
	mcp: McpExport;
	resources: { tools: unknown; commands: unknown; skills: unknown };
	context: { projection: unknown; promptOptions: unknown };
}

export const runExport: Subcommand = async (args, ctx, deps) => {
	const requested = (args.positionals[0] ?? "jsonl").toLowerCase();
	const format = requested === "md" ? "markdown" : requested;
	if (format !== "jsonl" && format !== "markdown") {
		return {
			title: "/debug export",
			lines: [
				`unknown format "${requested}". Use: jsonl | markdown [path] [--force]`,
				"Only /debug export writes files; all other commands are UI-only.",
			],
		};
	}
	const extension = format === "jsonl" ? "jsonl" : "md";
	const explicitPath = args.positionals[1];
	const force = flagBool(args.flags, "force");

	const target = explicitPath ? resolve(ctx.cwd, explicitPath) : defaultPath(ctx.cwd, extension);
	const pathError = await checkPath(target, ctx.cwd);
	if (pathError) {
		return { title: "/debug export", lines: [`refused: ${pathError}`, "Nothing was written."] };
	}

	const data = buildExportData(ctx, deps);
	const payload = format === "jsonl" ? buildJsonl(data) : buildMarkdown(data);
	try {
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, payload, { mode: 0o600, flag: force ? "w" : "wx" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const hint = !force && /exist/i.test(message) ? " Pass --force to overwrite an existing file." : "";
		return { title: "/debug export", lines: [`failed to write: ${message}${hint}`, "Nothing was written."] };
	}

	return {
		title: "/debug export",
		lines: [
			`wrote ${format} export: ${target}`,
			`bytes: ${formatBytes(Buffer.byteLength(payload, "utf8"))}`,
			"redaction: sensitive keys (authorization/cookie/api key/token/secret) are removed, images are replaced by metadata, thinking content is never exported.",
			"file mode: 0600",
			`read it back with: cat ${JSON.stringify(target)}`,
		],
	};
};

function defaultPath(cwd: string, extension: string): string {
	const now = new Date();
	const stamp = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
		"-",
		String(now.getHours()).padStart(2, "0"),
		String(now.getMinutes()).padStart(2, "0"),
		String(now.getSeconds()).padStart(2, "0"),
	].join("");
	return join(cwd, "debug-exports", `debug-export-${stamp}.${extension}`);
}

/** Returns an error string when the path is unsafe, otherwise undefined. */
async function checkPath(target: string, cwd: string): Promise<string | undefined> {
	if (target.includes("\0")) return "path contains a NUL byte";
	if (!isAbsolute(target)) return "could not resolve an absolute path";
	if (!isInside(target, cwd) && !isInside(target, homedir()) && !isInside(target, tmpdir())) {
		return "path is outside cwd, the home directory, and the temp directory";
	}
	try {
		const info = await lstat(target);
		if (info.isSymbolicLink()) return "path is a symbolic link";
		if (info.isDirectory()) return "path is a directory";
	} catch {
		// Does not exist yet: that's fine.
	}
	return undefined;
}

function isInside(child: string, root: string): boolean {
	const rel = relative(root, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function buildExportData(ctx: ExtensionCommandContext, deps: CommandDeps): ExportData {
	const entries = safe(() => ctx.sessionManager.getEntries());
	const session: SessionMetrics | { unavailable: string } = entries.ok
		? computeSessionMetrics(entries.value as readonly unknown[])
		: { unavailable: entries.error };

	const options = safe(() => ctx.getSystemPromptOptions());
	const projection = safe(() => ctx.sessionManager.buildSessionProjection());
	const allTools = safe(() => deps.pi.getAllTools());
	const activeTools = safe(() => deps.pi.getActiveTools());
	const commands = safe(() => deps.pi.getCommands());

	const toolsSummary = allTools.ok
		? summarizeTools(allTools.value as readonly unknown[], activeTools.ok ? activeTools.value : [])
		: { unavailable: allTools.error };
	const commandsSummary = commands.ok
		? summarizeCommands(commands.value as readonly unknown[])
		: { unavailable: commands.error };
	const skillsSummary = options.ok ? summarizeSkills(options.value) : { unavailable: options.error };
	const projectionSummary = projection.ok
		? summarizeProjection(projection.value as unknown)
		: { unavailable: projection.error };
	const promptSummary = options.ok
		? summarizeSystemPromptOptions(options.value)
		: { unavailable: options.error };

	const inventory = readInventory(deps);
	const registered = readRegisteredServers(deps);
	const mcp: McpExport = {
		inventory: inventory.value ?? { unavailable: inventory.error ?? "unknown error" },
		registeredServers: registered.value ?? { unavailable: registered.error ?? "unknown error" },
		calls: deps.runtime.mcpCalls.snapshot(),
	};

	return {
		meta: {
			tool: "pi-debug-tool",
			version: "0.1.0",
			exportedAt: new Date(deps.runtime.clock.wallNow()).toISOString(),
			observerOnly: true,
		},
		trace: deps.runtime.trace.events(),
		metrics: deps.runtime.trace.snapshotMetrics(),
		session,
		mcp,
		resources: { tools: toolsSummary, commands: commandsSummary, skills: skillsSummary },
		context: { projection: projectionSummary, promptOptions: promptSummary },
	};
}

function buildJsonl(data: ExportData): string {
	const records: unknown[] = [data.meta];
	const trace = data.trace;
	for (const event of trace) records.push({ type: "trace", event });
	records.push({ type: "metrics", metrics: data.metrics });
	records.push({ type: "session", session: data.session });
	records.push({ type: "mcp", mcp: data.mcp });
	records.push({ type: "resources", resources: data.resources });
	records.push({ type: "context", context: data.context });
	return `${records.map((record) => JSON.stringify(sanitizeValue(record))).join("\n")}\n`;
}

function buildMarkdown(data: ExportData): string {
	const lines: string[] = [];
	lines.push("# pi-debug-tool export");
	lines.push("");
	lines.push(`- exported at: ${data.meta.exportedAt}`);
	lines.push("- observer-only: metadata only, no prompt/tool/thinking bodies");
	lines.push("");

	const metrics = data.metrics;
	lines.push("## metrics (observed)");
	lines.push(`- runs: started=${metrics.runs.started} ended=${metrics.runs.ended} settled=${metrics.runs.settled}`);
	lines.push(`- turns: ${metrics.turns}`);
	lines.push(
		`- tools: completed=${metrics.tools.completed} errors=${metrics.tools.errors} errorRate=${formatPercent(metrics.tools.errorRate)}`,
	);
	lines.push(`- events: recorded=${formatCount(metrics.events.recorded)} dropped=${formatCount(metrics.events.dropped)}`);
	lines.push("");

	lines.push("## session");
	if ("unavailable" in data.session) {
		lines.push(`- unavailable (${data.session.unavailable})`);
	} else {
		const session = data.session;
		lines.push(`- entries: ${formatCount(session.entriesTotal)}  messages: ${formatCount(session.messages.total)}`);
		lines.push(
			`- assistant usage: input=${formatCount(session.assistantUsage.input)} output=${formatCount(session.assistantUsage.output)} ` +
				`cacheRead=${formatCount(session.assistantUsage.cacheRead)} cacheWrite=${formatCount(session.assistantUsage.cacheWrite)} ` +
				`cost=${formatCost(session.assistantUsage.cost)}`,
		);
		lines.push(
			`- tool results: total=${formatCount(session.toolResults.total)} errors=${formatCount(session.toolResults.errors)} ` +
				`errorRate=${formatPercent(session.toolResults.errorRate)}`,
		);
	}
	lines.push("");

	lines.push("## mcp (native, observer-only)");
	if ("unavailable" in data.mcp.inventory) {
		lines.push(`- inventory: unavailable (${data.mcp.inventory.unavailable})`);
	} else {
		const inventory = data.mcp.inventory;
		lines.push(
			`- tools=${inventory.total} servers=${inventory.servers.length} declared=${inventory.declaredCount} ` +
				`callable=${inventory.callableCount} hidden=${inventory.hiddenCount}`,
		);
	}
	if ("unavailable" in data.mcp.registeredServers) {
		lines.push(`- extension registrations: unavailable (${data.mcp.registeredServers.unavailable})`);
	} else {
		const names = data.mcp.registeredServers.map((entry) => entry.name);
		lines.push(`- extension registrations: ${names.length > 0 ? names.join(", ") : "none"} (session-only, not connection state)`);
	}
	lines.push(
		`- observed calls: calls=${data.mcp.calls.calls} completed=${data.mcp.calls.ended} ` +
			`errors=${data.mcp.calls.errors} nested=${data.mcp.calls.nested} maxConcurrent=${data.mcp.calls.maxConcurrent}`,
	);
	lines.push("- connection state and mcp.json config are unavailable to extensions (use /mcp or `pi mcp list`)");
	lines.push("");

	lines.push("## resources");
	lines.push(`- ${JSON.stringify(sanitizeValue(data.resources))}`);
	lines.push("");
	lines.push("## context (summary)");
	lines.push(`- ${JSON.stringify(sanitizeValue(data.context))}`);
	lines.push("");
	lines.push("## trace");
	for (const event of data.trace) {
		lines.push(`- ${JSON.stringify(sanitizeValue(event))}`);
	}
	lines.push("");
	return lines.join("\n");
}
