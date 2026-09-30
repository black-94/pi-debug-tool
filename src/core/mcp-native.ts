import type { ToolAnnotations, ToolExposure } from "@earendil-works/pi-coding-agent";
import { percentile } from "./metrics";
import { sanitizeLabel } from "./redaction";

/**
 * Read-only, native-MCP bookkeeping for Pi 0.99.x.
 *
 * This module knows only about what Pi exposes publicly:
 * - tool metadata from `pi.getAllTools()` / `pi.getActiveTools()` (name, exposure,
 *   namespace, annotations, sourceInfo);
 * - native tool execution events (`tool_execution_start` / `tool_execution_end`),
 *   which carry `toolCallId`, `toolName`, `isError`, and `parentToolCallId`.
 *
 * It deliberately does NOT know, and never claims to know:
 * - MCP connection state (connected / failed / needs-auth);
 * - `mcp.json` configuration (servers, transports, urls/commands);
 * - env, headers, credentials, OAuth state, or resources.
 *
 * Pi exposes no public API for those, so callers must report them as
 * `unavailable` and point the user at `/mcp` and `pi mcp list`.
 *
 * Identity: Pi constructs an MCP tool's namespace name as `mcp__<server>` with no
 * extra separator, so `namespace.name` resolves the server exactly even when the
 * server name itself contains `__`. The tool name `mcp__<server>__<tool>` is only
 * parsed on its own when that split is unambiguous; otherwise the server is left
 * unknown rather than guessed.
 *
 * Nothing here stores tool arguments, results, error text, prompts, or
 * credentials: only counts, ids as keys, durations, exposure and source metadata.
 */

/** Documented MCP tool naming convention (`docs/mcp.md`): `mcp__<server>__<tool>`. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";
/** Server names may only contain letters, digits, `_`, and `-` (`docs/mcp.md`). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const EXPOSURES: readonly ToolExposure[] = ["direct", "model-only", "codemode", "deferred", "hidden"];

/** How a server was identified for one tool. */
export type McpServerSource = "namespace" | "name" | "unknown" | "conflict";

export interface McpToolIdentity {
	/** Exact server when resolvable, or null when ambiguous/unknown. */
	server: string | null;
	/** Server-side tool name when resolvable, or null when unknown. */
	tool: string | null;
	/** Namespace name as Pi reports it, e.g. `mcp__github`. */
	namespaceName: string | null;
	/** Where `server` came from. */
	serverSource: McpServerSource;
	/** True when the raw name is MCP-prefixed but could not be resolved exactly. */
	ambiguous: boolean;
	/** True when the namespace and the name disagree about the server. */
	conflict: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Server name from a namespace name `mcp__<server>`; exact (may contain `__`). */
function serverFromNamespace(namespaceName: string | undefined): string | undefined {
	if (typeof namespaceName !== "string" || !namespaceName.startsWith(MCP_TOOL_NAME_PREFIX)) return undefined;
	const server = namespaceName.slice(MCP_TOOL_NAME_PREFIX.length);
	return server.length > 0 ? server : undefined;
}

/**
 * Parse the documented `mcp__<server>__<tool>` name on its own.
 *
 * Because a server name may itself contain `__`, this can only be exact when the
 * remainder after the first `__` contains no further `__` (otherwise the split is
 * ambiguous). Ambiguous names return `server: null` instead of guessing.
 */
export function parseMcpToolName(name: unknown): { server: string | null; tool: string | null; ambiguous: boolean } | undefined {
	if (typeof name !== "string" || !name.startsWith(MCP_TOOL_NAME_PREFIX)) return undefined;
	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const separator = rest.indexOf("__");
	if (separator <= 0) return { server: null, tool: null, ambiguous: true };
	const candidateServer = rest.slice(0, separator);
	const candidateTool = rest.slice(separator + 2);
	if (candidateTool.length === 0) return { server: null, tool: null, ambiguous: true };
	// A further `__` in the tool segment means the first split may be wrong.
	if (candidateTool.includes("__")) return { server: null, tool: null, ambiguous: true };
	if (!SERVER_NAME_PATTERN.test(candidateServer)) return { server: null, tool: null, ambiguous: true };
	return { server: candidateServer, tool: candidateTool, ambiguous: false };
}

/** True when a tool name uses the documented MCP prefix (even if malformed). */
export function hasMcpToolPrefix(name: unknown): boolean {
	return typeof name === "string" && name.startsWith(MCP_TOOL_NAME_PREFIX);
}

/**
 * Resolve a tool's MCP identity from its name and namespace.
 *
 * The namespace is authoritative. When only the name is available it is used
 * only if unambiguous. A disagreement between namespace and name yields
 * `server: null, conflict: true` rather than a wrong server.
 */
export function resolveMcpToolIdentity(name: unknown, namespaceName: unknown): McpToolIdentity | undefined {
	const toolName = typeof name === "string" ? name : undefined;
	const nsName = typeof namespaceName === "string" ? namespaceName : undefined;
	const nsServer = serverFromNamespace(nsName);
	const nameIsMcp = toolName !== undefined && toolName.startsWith(MCP_TOOL_NAME_PREFIX);
	if (!nameIsMcp && nsServer === undefined) return undefined;

	const byName = nameIsMcp ? parseMcpToolName(toolName) : undefined;
	const nameServer = byName?.server ?? null;
	const nameAmbiguous = byName?.ambiguous === true;

	if (nsServer !== undefined) {
		const conflict = nameServer !== null && nameServer !== nsServer;
		// Strip the exact `mcp__<server>__` prefix when present to recover the tool.
		let tool: string | null = null;
		if (toolName !== undefined) {
			const prefix = `${MCP_TOOL_NAME_PREFIX}${nsServer}__`;
			if (toolName.startsWith(prefix)) {
				const rest = toolName.slice(prefix.length);
				tool = rest.length > 0 ? rest : null;
			}
		}
		return {
			server: conflict ? null : nsServer,
			tool: tool ?? byName?.tool ?? null,
			namespaceName: nsName ?? null,
			serverSource: conflict ? "conflict" : "namespace",
			// The namespace resolves the server exactly, so a name-level ambiguity in
			// the tool segment no longer matters; only a conflict leaves it unknown.
			ambiguous: conflict,
			conflict,
		};
	}

	// No namespace: use the name only when exact.
	return {
		server: nameServer,
		tool: byName?.tool ?? null,
		namespaceName: nsName ?? null,
		serverSource: nameServer !== null ? "name" : "unknown",
		ambiguous: nameAmbiguous,
		conflict: false,
	};
}

function asExposure(value: unknown): ToolExposure | undefined {
	return typeof value === "string" && (EXPOSURES as readonly string[]).includes(value)
		? (value as ToolExposure)
		: undefined;
}

// ---------------------------------------------------------------------------
// Tool inventory (registered / declared / callable / hidden)
// ---------------------------------------------------------------------------

export interface McpToolEntry {
	/** Pi tool name, e.g. `mcp__github__search_code`. */
	name: string;
	/** Exact server, or null when unknown/ambiguous/conflicting. */
	server: string | null;
	serverSource: McpServerSource;
	/** Server-side tool name, or null when unknown. */
	tool: string | null;
	/** True when identity is ambiguous or the namespace and name disagree. */
	identityAmbiguous: boolean;
	/** Exposure from `getAllTools()`, or "unknown" when absent/unrecognized. */
	exposure: ToolExposure | "unknown";
	namespaceName: string | null;
	/** True when declared to the model; null when `getActiveTools()` was unavailable. */
	declared: boolean | null;
	/**
	 * Whether the tool is reachable from a tool (`ctx.executeTool()`/codemode) or
	 * declared to the model, derived from exposure semantics. null when unknown.
	 */
	callable: boolean | null;
	/** Registered but unreachable (`exposure: "hidden"`). */
	hidden: boolean;
	/** declared || callable; null when either is unknown. */
	reachable: boolean | null;
	annotations: ToolAnnotations | null;
	sourcePath: string | null;
	sourceSource: string | null;
	sourceScope: string | null;
	sourceOrigin: string | null;
}

export interface McpServerGroup {
	server: string;
	tools: number;
	declared: number;
	callable: number;
	hidden: number;
	unknownState: number;
}

export interface McpToolInventory {
	total: number;
	/** False when `getActiveTools()` failed, so declared/callable are unknown. */
	activeKnown: boolean;
	servers: McpServerGroup[];
	tools: McpToolEntry[];
	byExposure: Record<string, number>;
	declaredCount: number;
	declaredUnknownCount: number;
	callableCount: number;
	callableUnknownCount: number;
	hiddenCount: number;
	reachableCount: number;
	unknownExposureCount: number;
	ambiguousCount: number;
	/** MCP-prefixed names that are not `mcp__<server>__<tool>`; never guessed. */
	malformedNames: string[];
}

function isMcpTool(raw: Record<string, unknown>): boolean {
	const name = asString(raw.name);
	if (name && name.startsWith(MCP_TOOL_NAME_PREFIX)) return true;
	const namespace = isRecord(raw.namespace) ? raw.namespace : undefined;
	const namespaceName = namespace ? asString(namespace.name) : undefined;
	return typeof namespaceName === "string" && namespaceName.startsWith(MCP_TOOL_NAME_PREFIX);
}

function copyAnnotations(value: unknown): ToolAnnotations | null {
	if (!isRecord(value)) return null;
	const out: ToolAnnotations = {};
	if (typeof value.readOnlyHint === "boolean") out.readOnlyHint = value.readOnlyHint;
	if (typeof value.destructiveHint === "boolean") out.destructiveHint = value.destructiveHint;
	if (typeof value.idempotentHint === "boolean") out.idempotentHint = value.idempotentHint;
	if (typeof value.openWorldHint === "boolean") out.openWorldHint = value.openWorldHint;
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Derive `callable` / `reachable` from exposure, per `docs/extensions.md`:
 * - `direct`: declared while active, callable while active;
 * - `model-only`: declared while active, never callable;
 * - `codemode` / `deferred`: callable whenever registered (not declared unless activated);
 * - `hidden`: registered but unreachable;
 * - unknown exposure: not asserted (null).
 */
function callableFromExposure(exposure: McpToolEntry["exposure"], declared: boolean | null): boolean | null {
	switch (exposure) {
		case "direct":
			return declared;
		case "model-only":
		case "hidden":
			return false;
		case "codemode":
		case "deferred":
			return true;
		default:
			return null;
	}
}

/**
 * Summarize MCP tools from public `getAllTools()` / `getActiveTools()` output.
 *
 * `activeToolNames` may be null when `getActiveTools()` failed; then declared and
 * callable are reported as unknown instead of asserted false. MCP tools not being
 * declared (`codemode` / `deferred`) is normal and is never reported as
 * unavailable. Non-MCP tools are ignored.
 */
export function summarizeMcpTools(
	allTools: readonly unknown[],
	activeToolNames: readonly string[] | null,
): McpToolInventory {
	const active = activeToolNames === null ? null : new Set(activeToolNames.filter((name): name is string => typeof name === "string"));
	const tools: McpToolEntry[] = [];
	const malformedNames: string[] = [];

	for (const raw of allTools) {
		if (!isRecord(raw) || !isMcpTool(raw)) continue;
		const name = sanitizeLabel(asString(raw.name) ?? "(unnamed)");
		const namespace = isRecord(raw.namespace) ? raw.namespace : undefined;
		const namespaceName = namespace ? sanitizeLabel(asString(namespace.name) ?? "") : "";
		const identity = resolveMcpToolIdentity(asString(raw.name) ?? "", asString(namespace?.name));
		if (!identity) continue;

		if (identity.ambiguous || identity.server === null) {
			malformedNames.push(name);
		}

		const exposure = asExposure(raw.exposure);
		const declared = active === null ? null : active.has(asString(raw.name) ?? name);
		const hidden = exposure === "hidden";
		const callable = callableFromExposure(exposure ?? "unknown", declared);
		const reachable = declared === true || callable === true ? true : declared === null || callable === null ? null : false;
		const sourceInfo = isRecord(raw.sourceInfo) ? raw.sourceInfo : undefined;

		tools.push({
			name,
			server: identity.server === null ? null : sanitizeLabel(identity.server),
			serverSource: identity.serverSource,
			tool: identity.tool === null ? null : sanitizeLabel(identity.tool),
			identityAmbiguous: identity.ambiguous || identity.conflict || identity.server === null,
			exposure: exposure ?? "unknown",
			namespaceName: namespaceName.length > 0 ? namespaceName : null,
			declared,
			callable,
			hidden,
			reachable,
			annotations: copyAnnotations(raw.annotations),
			sourcePath: sourceInfo ? (sanitizeLabel(asString(sourceInfo.path) ?? "") || null) : null,
			sourceSource: sourceInfo ? (sanitizeLabel(asString(sourceInfo.source) ?? "") || null) : null,
			sourceScope: sourceInfo ? (sanitizeLabel(asString(sourceInfo.scope) ?? "") || null) : null,
			sourceOrigin: sourceInfo ? (sanitizeLabel(asString(sourceInfo.origin) ?? "") || null) : null,
		});
	}

	tools.sort((a, b) => (a.server ?? "\uffff").localeCompare(b.server ?? "\uffff") || a.name.localeCompare(b.name));

	const byExposure: Record<string, number> = {};
	const groups = new Map<string, McpServerGroup>();
	for (const tool of tools) {
		byExposure[tool.exposure] = (byExposure[tool.exposure] ?? 0) + 1;
		const key = tool.server ?? "(unknown)";
		const group = groups.get(key) ?? { server: key, tools: 0, declared: 0, callable: 0, hidden: 0, unknownState: 0 };
		group.tools += 1;
		if (tool.declared === true) group.declared += 1;
		if (tool.callable === true) group.callable += 1;
		if (tool.hidden) group.hidden += 1;
		if (tool.declared === null || tool.callable === null) group.unknownState += 1;
		groups.set(key, group);
	}

	return {
		total: tools.length,
		activeKnown: active !== null,
		servers: [...groups.values()].sort((a, b) => a.server.localeCompare(b.server)),
		tools,
		byExposure,
		declaredCount: tools.filter((tool) => tool.declared === true).length,
		declaredUnknownCount: tools.filter((tool) => tool.declared === null).length,
		callableCount: tools.filter((tool) => tool.callable === true).length,
		callableUnknownCount: tools.filter((tool) => tool.callable === null).length,
		hiddenCount: tools.filter((tool) => tool.hidden).length,
		reachableCount: tools.filter((tool) => tool.reachable === true).length,
		unknownExposureCount: tools.filter((tool) => tool.exposure === "unknown").length,
		ambiguousCount: tools.filter((tool) => tool.identityAmbiguous).length,
		malformedNames,
	};
}

// ---------------------------------------------------------------------------
// Call metadata (parallel-safe, codemode-correlated)
// ---------------------------------------------------------------------------

const DURATION_RESERVOIR = 200;
const MAX_DISTINCT_PARENTS = 256;
const MAX_ACTIVE = 512;
const MAX_TOOLS = 500;
const ENDED_HISTORY = 1024;

interface CallAccumulator {
	name: string;
	server: string | null;
	tool: string | null;
	calls: number;
	ended: number;
	errors: number;
	nested: number;
	durations: number[];
	lastWall?: number;
}

export interface McpCallToolStat {
	name: string;
	server: string | null;
	tool: string | null;
	calls: number;
	ended: number;
	errors: number;
	nested: number;
	/** Mean over paired durations, or null when none are available. */
	meanMs: number | null;
	p50Ms: number | null;
	p95Ms: number | null;
	maxMs: number | null;
	lastWall?: number;
}

export interface McpCallSummary {
	calls: number;
	ended: number;
	errors: number;
	errorRate: number | null;
	/** Calls whose `parentToolCallId` was set (e.g. issued by a codemode script or another tool). */
	nested: number;
	/** Highest number of MCP calls in flight at once. */
	maxConcurrent: number;
	/** Distinct parent tool call ids seen, capped; `parentsOverflow` marks the cap. */
	distinctParents: number;
	parentsOverflow: boolean;
	/** Ends with no matching start (e.g. after a dropped start); their duration is unavailable. */
	unpaired: number;
	/** Starts dropped because the active-call map was full; may under-count concurrency. */
	droppedStarts: number;
	/** Duplicate ends ignored (same toolCallId ended twice). */
	duplicateEnds: number;
	/** True when the per-tool table hit its cap; later tools are not listed. */
	toolOverflow: boolean;
	byTool: McpCallToolStat[];
}

/**
 * Aggregates metadata for native MCP tool calls.
 *
 * Counts, error flags, paired durations, concurrency, and parent correlation are
 * kept for every call regardless of tracing, so `/debug mcp calls` works when
 * `/debug trace` is off. Per-call bounded detail is read from the trace ring,
 * which respects the existing trace capacity rules; this class never stores
 * arguments, results, or error text.
 *
 * Duplicate ends and starts are ignored; all internal maps are bounded and drops
 * are visible in the snapshot.
 */
export class McpCallStats {
	private readonly calls = new Map<string, CallAccumulator>();
	private readonly active = new Map<string, string>();
	private readonly parents = new Set<string>();
	private readonly endedIds = new Set<string>();
	private readonly endedOrder: string[] = [];
	private parentsOverflow = false;
	private perCall = 0;
	private ended = 0;
	private errors = 0;
	private nested = 0;
	private maxConcurrent = 0;
	private unpaired = 0;
	private droppedStarts = 0;
	private duplicateEnds = 0;
	private toolOverflow = false;

	/** Register a native MCP call start. Duplicate or already-ended ids are ignored. */
	begin(toolCallId: string, toolName: string, parentToolCallId: string | undefined, wall: number): void {
		if (this.active.has(toolCallId) || this.endedIds.has(toolCallId)) return;
		if (this.active.size >= MAX_ACTIVE) {
			// Drop the oldest in-flight start; its end will be reported as unpaired.
			const oldest = this.active.keys().next().value;
			if (typeof oldest === "string") this.active.delete(oldest);
			this.droppedStarts += 1;
		}
		const key = sanitizeLabel(toolName, 160);
		const acc = this.accumulator(key);
		acc.calls += 1;
		acc.lastWall = wall;
		this.perCall += 1;
		if (parentToolCallId !== undefined) {
			acc.nested += 1;
			this.nested += 1;
			this.noteParent(parentToolCallId);
		}
		this.active.set(toolCallId, key);
		if (this.active.size > this.maxConcurrent) this.maxConcurrent = this.active.size;
	}

	/**
	 * Register a native MCP call end.
	 *
	 * A duplicate end for an id that already ended is ignored. An end with no
	 * matching start is counted (`unpaired`) but contributes no duration, so it
	 * cannot distort percentiles as a zero.
	 */
	end(toolCallId: string, toolName: string, isError: boolean, durationMs: number | undefined, wall: number): void {
		if (this.endedIds.has(toolCallId)) {
			this.duplicateEnds += 1;
			return;
		}
		const key = this.active.get(toolCallId) ?? sanitizeLabel(toolName, 160);
		this.rememberEnded(toolCallId);
		this.active.delete(toolCallId);
		const acc = this.accumulator(key);
		acc.ended += 1;
		if (isError) acc.errors += 1;
		this.ended += 1;
		if (isError) this.errors += 1;
		acc.lastWall = wall;
		if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
			acc.durations.push(durationMs);
			if (acc.durations.length > DURATION_RESERVOIR) acc.durations.shift();
		} else {
			this.unpaired += 1;
		}
	}

	/** Forget state for an unobserved call id that Pi says is gone (best effort). */
	private rememberEnded(toolCallId: string): void {
		if (this.endedIds.has(toolCallId)) return;
		this.endedIds.add(toolCallId);
		this.endedOrder.push(toolCallId);
		if (this.endedOrder.length > ENDED_HISTORY) {
			const oldest = this.endedOrder.shift();
			if (oldest !== undefined) this.endedIds.delete(oldest);
		}
	}

	private noteParent(parentToolCallId: string): void {
		if (this.parents.has(parentToolCallId)) return;
		if (this.parents.size >= MAX_DISTINCT_PARENTS) {
			this.parentsOverflow = true;
			return;
		}
		this.parents.add(parentToolCallId);
	}

	private accumulator(toolName: string): CallAccumulator {
		let acc = this.calls.get(toolName);
		if (!acc) {
			if (this.calls.size >= MAX_TOOLS) {
				this.toolOverflow = true;
				// Reuse a single overflow bucket so totals stay correct and memory bounded.
				const overflow = this.calls.get("(other)");
				if (overflow) return overflow;
				acc = { name: "(other)", server: null, tool: null, calls: 0, ended: 0, errors: 0, nested: 0, durations: [] };
				this.calls.set("(other)", acc);
				return acc;
			}
			const identity = resolveMcpToolIdentity(toolName, undefined);
			acc = {
				name: toolName,
				server: identity?.server ?? null,
				tool: identity?.tool ?? null,
				calls: 0,
				ended: 0,
				errors: 0,
				nested: 0,
				durations: [],
			};
			this.calls.set(toolName, acc);
		}
		return acc;
	}

	snapshot(): McpCallSummary {
		const byTool: McpCallToolStat[] = [...this.calls.values()]
			.map((acc) => {
				const sorted = [...acc.durations].sort((a, b) => a - b);
				const sum = sorted.reduce((total, value) => total + value, 0);
				return {
					name: acc.name,
					server: acc.server,
					tool: acc.tool,
					calls: acc.calls,
					ended: acc.ended,
					errors: acc.errors,
					nested: acc.nested,
					meanMs: sorted.length === 0 ? null : sum / sorted.length,
					p50Ms: sorted.length === 0 ? null : percentile(sorted, 0.5),
					p95Ms: sorted.length === 0 ? null : percentile(sorted, 0.95),
					maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] as number),
					lastWall: acc.lastWall,
				};
			})
			.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

		return {
			calls: this.perCall,
			ended: this.ended,
			errors: this.errors,
			errorRate: this.ended === 0 ? null : this.errors / this.ended,
			nested: this.nested,
			maxConcurrent: this.maxConcurrent,
			distinctParents: this.parents.size,
			parentsOverflow: this.parentsOverflow,
			unpaired: this.unpaired,
			droppedStarts: this.droppedStarts,
			duplicateEnds: this.duplicateEnds,
			toolOverflow: this.toolOverflow,
			byTool,
		};
	}

	reset(): void {
		this.calls.clear();
		this.active.clear();
		this.parents.clear();
		this.endedIds.clear();
		this.endedOrder.length = 0;
		this.parentsOverflow = false;
		this.perCall = 0;
		this.ended = 0;
		this.errors = 0;
		this.nested = 0;
		this.maxConcurrent = 0;
		this.unpaired = 0;
		this.droppedStarts = 0;
		this.duplicateEnds = 0;
		this.toolOverflow = false;
	}
}
