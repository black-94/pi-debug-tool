import {
	type McpCallSummary,
	type McpServerGroup,
	type McpToolEntry,
	type McpToolInventory,
	hasMcpToolPrefix,
	summarizeMcpTools,
} from "../core/mcp-native";
import { formatCount, formatDurationMs, formatPercent, renderTable } from "../core/format";
import { sanitizeLabel } from "../core/redaction";
import { flagNumber, flagString } from "./args";
import { safe, type CommandDeps, type Subcommand } from "./deps";

/**
 * `/debug mcp` — native Pi MCP debugging, observer-only.
 *
 * Everything shown comes from read-only public APIs:
 * - `pi.getAllTools()` / `pi.getActiveTools()` for tool inventory and exposure;
 * - `pi.getMcpServers()` for extension registrations (names and the registering
 *   extension path only — never their config);
 * - `pi.getCommands()` to identify which source provides `/mcp`;
 * - observed native `tool_execution_*` events (and the trace ring) for call metadata.
 *
 * Connection state, `mcp.json` configuration, transports, env, headers,
 * credentials, OAuth state, and resources are NOT available through the public
 * API. They are reported as `unavailable` and the user is pointed at `/mcp` and
 * `pi mcp list`. This command never connects, starts, reconnects, or toggles a
 * server, and never issues a call.
 */

const SEPARATOR = "─".repeat(58);
const TOPICS = new Set(["overview", "tools", "calls", "doctor"]);
const DEFAULT_LIMIT = 50;
const MAX_DETAIL_ROWS = 100;
/** Prefix of synthetic built-in paths such as `builtin:mcp` (`core/source-info.ts` docs). */
const BUILTIN_PATH_PREFIX = "builtin:";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yesNo(value: boolean | null): string {
	return value === null ? "?" : value ? "yes" : "no";
}

export interface RegisteredServerInfo {
	name: string;
	/** Path of the extension that registered the server. Config is deliberately not read. */
	extensionPath: string;
}

/**
 * Which source provides the `/mcp` command, from public command metadata.
 *
 * Pi's built-in MCP integration also registers `/mcp` as an extension command,
 * with a synthetic `builtin:` path and `sourceInfo.source === "builtin"`. Only a
 * non-builtin command means the built-in MCP support was replaced.
 */
export type McpCommandProvider =
	| { kind: "builtin"; path: string }
	| { kind: "extension"; path: string; source: string }
	| { kind: "unknown"; path: string | null }
	| { kind: "none" };

/** Read `pi.getMcpServers()` defensively; only names and extension paths are copied. */
export function readRegisteredServers(deps: CommandDeps): { value: RegisteredServerInfo[] | null; error?: string } {
	const fn = (deps.pi as { getMcpServers?: () => unknown }).getMcpServers;
	if (typeof fn !== "function") {
		return { value: null, error: "getMcpServers() is not available in this Pi version" };
	}
	const result = safe(() => fn.call(deps.pi));
	if (!result.ok) return { value: null, error: result.error };
	if (!Array.isArray(result.value)) return { value: null, error: "getMcpServers() did not return an array" };
	const servers: RegisteredServerInfo[] = [];
	for (const entry of result.value) {
		if (!isRecord(entry)) continue;
		const name = typeof entry.name === "string" ? sanitizeLabel(entry.name) : undefined;
		if (!name) continue;
		servers.push({
			name,
			extensionPath: typeof entry.extensionPath === "string" ? sanitizeLabel(entry.extensionPath) : "(unknown)",
		});
	}
	return { value: servers };
}

/** Identify the source of the `/mcp` command (built-in vs a replacing extension). */
export function readMcpCommandProvider(deps: CommandDeps): McpCommandProvider {
	const commands = safe(() => deps.pi.getCommands());
	if (!commands.ok || !Array.isArray(commands.value)) return { kind: "none" };
	for (const command of commands.value) {
		if (!isRecord(command)) continue;
		if (command.name !== "mcp") continue;
		if (command.source !== "extension") continue;
		const sourceInfo: Record<string, unknown> = isRecord(command.sourceInfo) ? command.sourceInfo : {};
		const source = typeof sourceInfo.source === "string" ? sourceInfo.source : null;
		const path = typeof sourceInfo.path === "string" ? sanitizeLabel(sourceInfo.path) : null;
		if (source === "builtin" || (path !== null && path.startsWith(BUILTIN_PATH_PREFIX))) {
			return { kind: "builtin", path: path ?? `${BUILTIN_PATH_PREFIX}mcp` };
		}
		if (source === null) return { kind: "unknown", path };
		return { kind: "extension", path: path ?? "(unknown)", source: sanitizeLabel(source) };
	}
	return { kind: "none" };
}

/**
 * Read the native MCP tool inventory.
 *
 * `getActiveTools()` failing yields unknown declared/callable state rather than
 * asserting tools are inactive. All reads are wrapped and errors are sanitized.
 */
export function readInventory(deps: CommandDeps): { value: McpToolInventory | null; error?: string; note?: string } {
	const all = safe(() => deps.pi.getAllTools());
	if (!all.ok) return { value: null, error: all.error };
	if (!Array.isArray(all.value)) return { value: null, error: "getAllTools() did not return an array" };
	const activeResult = safe(() => deps.pi.getActiveTools());
	const active = activeResult.ok && Array.isArray(activeResult.value) ? (activeResult.value as string[]) : null;
	const inventory = safe(() => summarizeMcpTools(all.value as readonly unknown[], active));
	if (!inventory.ok) return { value: null, error: inventory.error };
	const note =
		active === null
			? `getActiveTools unavailable: ${activeResult.ok ? "non-array result" : activeResult.error}`
			: undefined;
	return { value: inventory.value, note };
}

function serverName(entry: McpToolEntry): string {
	return entry.server ?? (entry.identityAmbiguous ? "(ambiguous)" : "(unknown)");
}

function toolLabel(entry: McpToolEntry): string {
	return entry.tool ?? entry.name;
}

function annotationFlags(entry: McpToolEntry): string {
	const flags: string[] = [];
	if (entry.annotations?.readOnlyHint === true) flags.push("ro");
	if (entry.annotations?.destructiveHint === true) flags.push("dest");
	if (entry.annotations?.idempotentHint === true) flags.push("idem");
	if (entry.annotations?.openWorldHint === true) flags.push("open");
	return flags.length > 0 ? flags.join(",") : "-";
}

function filterTools(inventory: McpToolInventory, server: string | undefined): McpToolEntry[] {
	if (!server) return inventory.tools;
	return inventory.tools.filter((entry) => entry.server === server);
}

function filterGroups(inventory: McpToolInventory, server: string | undefined): McpServerGroup[] {
	if (!server) return inventory.servers;
	return inventory.servers.filter((group) => group.server === server);
}

/** Trustworthy server per raw tool name, taken from the inventory's namespace identity. */
function serverByToolName(inventory: McpToolInventory | null): Map<string, string> {
	const map = new Map<string, string>();
	if (!inventory) return map;
	for (const entry of inventory.tools) {
		if (entry.server) map.set(entry.name, entry.server);
	}
	return map;
}

function exposureSummary(inventory: McpToolInventory): string {
	const parts = Object.entries(inventory.byExposure)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([exposure, count]) => `${exposure}=${count}`);
	return parts.length > 0 ? parts.join(" ") : "none";
}

function callTotals(summary: McpCallSummary): string {
	const extras: string[] = [];
	if (summary.unpaired > 0) extras.push(`unpaired=${summary.unpaired}`);
	if (summary.droppedStarts > 0) extras.push(`droppedStarts=${summary.droppedStarts}`);
	if (summary.duplicateEnds > 0) extras.push(`duplicateEnds=${summary.duplicateEnds}`);
	const suffix = extras.length > 0 ? ` ${extras.join(" ")}` : "";
	return (
		`calls=${summary.calls} completed=${summary.ended} errors=${summary.errors} ` +
		`errorRate=${formatPercent(summary.errorRate)} nested=${summary.nested} ` +
		`maxConcurrent=${summary.maxConcurrent}${suffix}`
	);
}

function unavailableLines(): string[] {
	return [
		"unavailable through public extension APIs (use /mcp or `pi mcp list`):",
		"  - connection status (connected / failed / needs-auth), reconnect state",
		"  - enabled/disabled state and the configured server list from mcp.json",
		"  - server definitions, transport, url/command, env, headers, credentials, OAuth",
		"  - resources, prompts, logging, and per-server errors",
	];
}

// ---------------------------------------------------------------------------
// Subcommand
// ---------------------------------------------------------------------------

export const runMcp: Subcommand = async (args, _ctx, deps) => {
	const rawFirst = args.positionals[0]?.toLowerCase();
	const topic = rawFirst && TOPICS.has(rawFirst) ? rawFirst : "overview";
	const positionalServer = rawFirst && TOPICS.has(rawFirst) ? args.positionals[1] : args.positionals[0];
	const server = flagString(args.flags, "server") ?? positionalServer;
	const limit = Math.max(1, flagNumber(args.flags, "limit", DEFAULT_LIMIT));
	const title = `/debug mcp ${topic}${server ? ` ${server}` : ""}`;

	switch (topic) {
		case "tools":
			return { title, lines: toolsLines(deps, server, limit) };
		case "calls":
			return { title, lines: callsLines(deps, server, limit) };
		case "doctor":
			return { title, lines: doctorLines(deps) };
		default:
			return { title, lines: overviewLines(deps, server, limit) };
	}
};

function overviewLines(deps: CommandDeps, server: string | undefined, limit: number): string[] {
	const lines: string[] = ["pi-debug-tool — native MCP overview (observer-only)", SEPARATOR];
	const inventory = readInventory(deps);
	if (!inventory.value) {
		lines.push(`tool inventory: unavailable (${inventory.error ?? "unknown error"})`);
	} else {
		const filtered = filterGroups(inventory.value, server);
		lines.push(
			`native MCP tools (getAllTools): ${formatCount(inventory.value.total)} across ${
				inventory.value.servers.length
			} server(s)`,
		);
		lines.push(`  exposure: ${exposureSummary(inventory.value)}`);
		lines.push(
			`  declared to model now: ${formatCount(inventory.value.declaredCount)}${
				inventory.value.declaredUnknownCount > 0 ? ` (+${inventory.value.declaredUnknownCount} unknown)` : ""
			}  ` +
				`callable from tools: ${formatCount(inventory.value.callableCount)}${
					inventory.value.callableUnknownCount > 0 ? ` (+${inventory.value.callableUnknownCount} unknown)` : ""
				}  ` +
				`hidden/unreachable: ${formatCount(inventory.value.hiddenCount)}`,
		);
		if (!inventory.value.activeKnown) {
			lines.push(`  ! declared/callable state is partially unknown (${inventory.note}).`);
		}
		lines.push(
			"  note: codemode/deferred tools are callable even though they are not declared to the model.",
		);
		if (server && filtered.length === 0) {
			lines.push(`  ! server filter "${sanitizeLabel(server)}" matched no server with native MCP tools.`);
			lines.push(`    known servers: ${inventory.value.servers.map((group) => group.server).join(", ") || "none"}`);
		} else if (filtered.length > 0) {
			const rows = filtered.slice(0, limit).map((group) => [
				group.server,
				formatCount(group.tools),
				formatCount(group.declared),
				formatCount(group.callable),
				formatCount(group.hidden),
				group.unknownState > 0 ? formatCount(group.unknownState) : "-",
			]);
			lines.push("");
			lines.push(...renderTable(["server", "tools", "declared", "callable", "hidden", "unknown"], rows));
			if (filtered.length > limit) lines.push(`  …(+${filtered.length - limit} more; pass --limit N)`);
		}
		if (inventory.value.ambiguousCount > 0) {
			lines.push(
				`  ! ${inventory.value.ambiguousCount} tool(s) have an ambiguous or conflicting MCP identity; server is reported as unknown, not guessed.`,
			);
		}
	}

	lines.push("");
	const registered = readRegisteredServers(deps);
	if (!registered.value) {
		lines.push(`extension-registered MCP servers (getMcpServers): unavailable (${registered.error})`);
	} else if (registered.value.length === 0) {
		lines.push("extension-registered MCP servers (getMcpServers): none");
	} else {
		lines.push(`extension-registered MCP servers (getMcpServers): ${registered.value.length}`);
		const rows = registered.value.slice(0, limit).map((entry) => [entry.name, entry.extensionPath]);
		lines.push(...renderTable(["server", "registered by"], rows));
	}
	lines.push("  note: these are session registrations by extensions, not mcp.json entries, and not connection state.");

	const provider = readMcpCommandProvider(deps);
	if (provider.kind === "extension") {
		lines.push(
			`  note: /mcp is provided by an extension (${provider.path}); built-in MCP support is replaced while it is loaded.`,
		);
	} else if (provider.kind === "unknown") {
		lines.push("  note: an extension /mcp command was observed, but its source could not be identified from public metadata.");
	}

	lines.push("");
	lines.push(`observed native MCP calls (metadata only): ${callTotals(deps.runtime.mcpCalls.snapshot())}`);
	lines.push("  see /debug mcp calls for per-tool detail; counts are kept even when tracing is off.");
	lines.push("");
	lines.push(...unavailableLines());
	lines.push(SEPARATOR);
	lines.push("read-only: never connects, calls, reconnects, or toggles any MCP server.");
	return lines;
}

function toolsLines(deps: CommandDeps, server: string | undefined, limit: number): string[] {
	const lines: string[] = ["pi-debug-tool — native MCP tools (observer-only)", SEPARATOR];
	const inventory = readInventory(deps);
	if (!inventory.value) {
		lines.push(`unavailable (${inventory.error})`);
		return lines;
	}
	const tools = filterTools(inventory.value, server);
	if (server && tools.length === 0) {
		lines.push(`no native MCP tools for server "${sanitizeLabel(server)}".`);
		lines.push(`known servers: ${inventory.value.servers.map((group) => group.server).join(", ") || "none"}`);
		return lines;
	}
	if (tools.length === 0) {
		lines.push("no native MCP tools registered (getAllTools).");
		lines.push("This can mean no server is configured, servers are still connecting, or MCP is replaced/disabled.");
		lines.push("Verify with /mcp or `pi mcp list`; connection state is not exposed to extensions.");
		return lines;
	}
	lines.push("declared = in getActiveTools() (exposed to the model); callable = reachable from tools/codemode (derived from exposure).");
	if (!inventory.value.activeKnown) lines.push(`! declared/callable partially unknown (${inventory.note}).`);
	lines.push("");
	const rows = tools.slice(0, limit).map((entry) => [
		serverName(entry),
		toolLabel(entry),
		entry.exposure,
		yesNo(entry.declared),
		yesNo(entry.callable),
		entry.hidden ? "yes" : "no",
		annotationFlags(entry),
		entry.sourcePath ?? "-",
	]);
	lines.push(
		...renderTable(["server", "tool", "exposure", "declared", "callable", "hidden", "hints", "source"], rows),
	);
	if (tools.length > limit) lines.push(`…(+${tools.length - limit} more; pass --limit N)`);
	lines.push("");
	lines.push(
		`totals: tools=${formatCount(inventory.value.total)} declared=${formatCount(inventory.value.declaredCount)} ` +
			`callable=${formatCount(inventory.value.callableCount)} hidden=${formatCount(inventory.value.hiddenCount)} ` +
			`unknownState=${formatCount(inventory.value.declaredUnknownCount + inventory.value.callableUnknownCount)}`,
	);
	return lines;
}

interface McpCallDetail {
	toolCallId: string;
	parentToolCallId: string | null;
	name: string;
	status: "ok" | "error" | "started";
	durationMs: number | undefined;
}

/**
 * Bounded per-call detail from the trace ring (populated only while tracing is
 * on). Correlates starts and ends by toolCallId and keeps only MCP-prefixed calls.
 */
function recentCallDetails(deps: CommandDeps, serverMap: Map<string, string>, server: string | undefined, limit: number): McpCallDetail[] {
	const started = new Map<string, { name: string; parent: string | null }>();
	const details: McpCallDetail[] = [];
	for (const event of deps.runtime.trace.events()) {
		if (event.kind !== "tool") continue;
		const data: Record<string, unknown> = isRecord(event.data) ? event.data : {};
		const name = typeof data.toolName === "string" ? data.toolName : undefined;
		if (!name || !hasMcpToolPrefix(name)) continue;
		const id = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
		if (event.name === "tool_execution_start") {
			started.set(id, {
				name,
				parent: typeof data.parentToolCallId === "string" ? data.parentToolCallId : null,
			});
		} else if (event.name === "tool_execution_end") {
			const start = started.get(id);
			started.delete(id);
			details.push({
				toolCallId: id,
				parentToolCallId: start?.parent ?? (typeof data.parentToolCallId === "string" ? data.parentToolCallId : null),
				name: start?.name ?? name,
				status: data.isError === true ? "error" : "ok",
				durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
			});
		}
	}
	for (const [id, start] of started) {
		details.push({ toolCallId: id, parentToolCallId: start.parent, name: start.name, status: "started", durationMs: undefined });
	}
	const filtered = server
		? details.filter((detail) => (serverMap.get(detail.name) ?? null) === server)
		: details;
	return filtered.slice(-Math.min(limit, MAX_DETAIL_ROWS));
}

function callsLines(deps: CommandDeps, server: string | undefined, limit: number): string[] {
	const lines: string[] = ["pi-debug-tool — native MCP calls (metadata only)", SEPARATOR];
	const inventory = readInventory(deps);
	const serverMap = serverByToolName(inventory.value);
	const summary = deps.runtime.mcpCalls.snapshot();
	const byTool = server
		? summary.byTool.filter((stat) => (serverMap.get(stat.name) ?? stat.server ?? null) === server)
		: summary.byTool;
	if (byTool.length === 0) {
		lines.push(
			server
				? `no observed native MCP calls for server "${sanitizeLabel(server)}" since the last session start / clear.`
				: "no observed native MCP calls since the last session start / clear.",
		);
		lines.push("metadata is recorded from tool_execution_start/end and needs no tracing.");
		return lines;
	}
	lines.push(`totals: ${callTotals(summary)} distinctParents=${summary.distinctParents}${summary.parentsOverflow ? "+" : ""}`);
	lines.push("nested = calls issued by a tool (for example a codemode script), identified by parentToolCallId.");
	if (summary.unpaired > 0) lines.push(`! ${summary.unpaired} completion(s) had no matching start; their duration is unavailable.`);
	if (summary.toolOverflow) lines.push("! the per-tool table hit its cap; extra tool names are merged into (other).");
	lines.push("");
	const rows = byTool.slice(0, limit).map((stat) => [
		serverMap.get(stat.name) ?? stat.server ?? "(unknown)",
		stat.tool ?? stat.name,
		formatCount(stat.calls),
		formatCount(stat.ended),
		formatCount(stat.errors),
		formatPercent(stat.ended === 0 ? null : stat.errors / stat.ended),
		formatDurationMs(stat.meanMs ?? undefined),
		formatDurationMs(stat.p95Ms ?? undefined),
		formatDurationMs(stat.maxMs ?? undefined),
		formatCount(stat.nested),
	]);
	lines.push(
		...renderTable(
			["server", "tool", "calls", "done", "errors", "err%", "mean", "p95", "max", "nested"],
			rows,
		),
	);
	if (byTool.length > limit) lines.push(`…(+${byTool.length - limit} more; pass --limit N)`);
	lines.push("");
	lines.push("Never stored: tool arguments, results, or error text.");

	// Per-call detail is available only from the trace ring.
	if (!deps.runtime.trace.isEnabled()) {
		lines.push("per-call detail (toolCallId/parent/status/duration) needs /debug trace on.");
		return lines;
	}
	const details = recentCallDetails(deps, serverMap, server, limit);
	lines.push(`per-call detail (last ${details.length} of the trace ring, bounded by ring capacity):`);
	if (details.length === 0) {
		lines.push("  (no MCP tool events in the current ring)");
		return lines;
	}
	const detailRows = details.map((detail) => [
		sanitizeLabel(detail.toolCallId, 60),
		detail.parentToolCallId ? sanitizeLabel(detail.parentToolCallId, 60) : "-",
		serverMap.get(detail.name) ?? "(unknown)",
		detail.name,
		detail.status,
		formatDurationMs(detail.durationMs),
	]);
	lines.push(...renderTable(["toolCallId", "parent", "server", "tool", "status", "duration"], detailRows));
	return lines;
}

function doctorLines(deps: CommandDeps): string[] {
	const findings: Array<{ level: "ok" | "info" | "warn" | "unknown"; text: string }> = [];
	const inventory = readInventory(deps);
	const summary = deps.runtime.mcpCalls.snapshot();

	if (!inventory.value) {
		findings.push({ level: "unknown", text: `MCP tool inventory is unavailable (${inventory.error}).` });
	} else if (inventory.value.total === 0) {
		findings.push({
			level: "info",
			text: "No native MCP tools are registered via the public API. This is not a verdict: no server may be configured, servers may still be connecting, or MCP may be replaced/disabled. Verify with /mcp or `pi mcp list`.",
		});
	} else {
		findings.push({
			level: "ok",
			text: `Native MCP tools observed: ${formatCount(inventory.value.total)} across ${inventory.value.servers.length} server(s); declared=${inventory.value.declaredCount} callable=${inventory.value.callableCount} hidden=${inventory.value.hiddenCount}.`,
		});
	}
	if (inventory.value && !inventory.value.activeKnown) {
		findings.push({
			level: "unknown",
			text: `Declared/callable state is partially unknown (${inventory.note}); not asserted.`,
		});
	}
	if (inventory.value && inventory.value.hiddenCount > 0) {
		const hidden = inventory.value.tools.filter((tool) => tool.hidden).map((tool) => tool.name);
		findings.push({
			level: "info",
			text: `${formatCount(inventory.value.hiddenCount)} MCP tool(s) are registered but hidden (unreachable): ${hidden.slice(0, 5).join(", ")}${hidden.length > 5 ? ", …" : ""}.`,
		});
	}
	if (inventory.value && inventory.value.unknownExposureCount > 0) {
		findings.push({
			level: "info",
			text: `${formatCount(inventory.value.unknownExposureCount)} MCP tool(s) reported no recognized exposure; callable state is not asserted for them.`,
		});
	}
	if (inventory.value && inventory.value.ambiguousCount > 0) {
		findings.push({
			level: "warn",
			text: `${formatCount(inventory.value.ambiguousCount)} MCP tool(s) have an ambiguous/conflicting identity; the server is reported as unknown, not guessed.`,
		});
	}

	const registered = readRegisteredServers(deps);
	if (!registered.value) {
		findings.push({ level: "info", text: `Extension MCP registrations unavailable (${registered.error}).` });
	} else if (registered.value.length > 0) {
		findings.push({
			level: "info",
			text: `${registered.value.length} server(s) are registered by extensions (session-only; not connection state).`,
		});
	}

	const provider = readMcpCommandProvider(deps);
	if (provider.kind === "extension") {
		findings.push({
			level: "info",
			text: `/mcp is provided by an extension (${provider.path}); built-in MCP support is replaced while it is loaded.`,
		});
	} else if (provider.kind === "builtin") {
		findings.push({ level: "ok", text: "/mcp is provided by Pi's built-in MCP integration." });
	} else if (provider.kind === "unknown") {
		findings.push({
			level: "info",
			text: "An extension /mcp command was observed, but its source could not be identified from public metadata.",
		});
	} else {
		findings.push({
			level: "info",
			text: "No /mcp command was observed; built-in MCP support may be disabled or replaced.",
		});
	}

	if (summary.calls > 0) {
		if (summary.errors > 0) {
			findings.push({
				level: summary.ended > 0 && summary.errors / summary.ended >= 0.2 ? "warn" : "info",
				text: `Observed ${formatCount(summary.errors)} MCP call error(s) out of ${formatCount(summary.ended)} completed (rate ${formatPercent(summary.errorRate)}).`,
			});
		} else {
			findings.push({
				level: "ok",
				text: `Observed ${formatCount(summary.ended)} native MCP call(s) with no errors; ${formatCount(summary.nested)} nested via codemode/other tools, max concurrent ${summary.maxConcurrent}.`,
			});
		}
		if (summary.unpaired > 0) {
			findings.push({
				level: "info",
				text: `${formatCount(summary.unpaired)} MCP completion(s) had no matching start; their duration is unavailable.`,
			});
		}
	}

	findings.push({
		level: "unknown",
		text: "Connection state, mcp.json config, transports, credentials, and resources are not exposed to extensions; this is expected, not an error. Use /mcp or `pi mcp list`.",
	});

	const lines: string[] = ["pi-debug-tool — /debug mcp doctor", SEPARATOR];
	for (const finding of findings) {
		const marker = finding.level === "ok" ? "ok  " : finding.level === "warn" ? "!   " : finding.level === "info" ? "i   " : "?   ";
		lines.push(`${marker}${finding.text}`);
	}
	lines.push(SEPARATOR);
	lines.push("Evidence only from getAllTools/getActiveTools, getMcpServers, getCommands, and observed tool events.");
	return lines;
}

// ---------------------------------------------------------------------------
// Integrations for other subcommands
// ---------------------------------------------------------------------------

/** Compact MCP lines for `/debug resources mcp`. */
export function mcpResourceLines(deps: CommandDeps): string[] {
	const lines: string[] = [];
	const inventory = readInventory(deps);
	if (!inventory.value) {
		lines.push(`tool inventory unavailable (${inventory.error})`);
	} else if (inventory.value.total === 0) {
		lines.push("no native MCP tools registered (getAllTools).");
		lines.push("Connection state and mcp.json config are unavailable to extensions; use /mcp or `pi mcp list`.");
	} else {
		lines.push(
			`native tools: ${formatCount(inventory.value.total)} across ${inventory.value.servers.length} server(s)  ` +
				`(declared=${inventory.value.declaredCount} callable=${inventory.value.callableCount} hidden=${inventory.value.hiddenCount})`,
		);
		const rows = inventory.value.servers.map((group) => [
			group.server,
			formatCount(group.tools),
			group.declared === null ? "?" : formatCount(group.declared),
			formatCount(group.callable),
			formatCount(group.hidden),
		]);
		lines.push(...renderTable(["server", "tools", "declared", "callable", "hidden"], rows));
	}

	const registered = readRegisteredServers(deps);
	lines.push(
		registered.value
			? `extension registrations (getMcpServers): ${registered.value.map((entry) => entry.name).join(", ") || "none"}`
			: `extension registrations (getMcpServers): unavailable (${registered.error})`,
	);
	lines.push(`observed calls: ${callTotals(deps.runtime.mcpCalls.snapshot())}`);
	lines.push("run /debug mcp [overview|tools|calls|doctor] for detail.");
	return lines;
}

/** One-line MCP summary for `/debug status`. */
export function mcpStatusLine(deps: CommandDeps): string {
	const inventory = readInventory(deps);
	const summary = deps.runtime.mcpCalls.snapshot();
	const calls = `calls=${summary.calls} errors=${summary.errors}`;
	if (!inventory.value) return `unavailable (${inventory.error})  ${calls}`;
	if (inventory.value.total === 0) {
		return "no native MCP tools registered (state/config not exposed; see /mcp)  " + calls;
	}
	return (
		`native tools=${inventory.value.total} servers=${inventory.value.servers.length} ` +
		`declared=${inventory.value.declaredCount}${inventory.value.declaredUnknownCount > 0 ? "?" : ""} ` +
		`callable=${inventory.value.callableCount}${inventory.value.callableUnknownCount > 0 ? "?" : ""} ` +
		`hidden=${inventory.value.hiddenCount}  ${calls}`
	);
}
