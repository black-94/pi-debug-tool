import { contextPercentToFraction, formatContextPercent, formatCount, formatPercent, renderBar } from "../core/format";
import { mcpStatusLine } from "./mcp";
import type { Subcommand } from "./deps";

const SEPARATOR = "─".repeat(58);

export const runStatus: Subcommand = async (_args, ctx, deps) => {
	const lines: string[] = [];
	lines.push("pi-debug-tool v0.1.0 — observer-only debug status");
	lines.push(SEPARATOR);

	// -- Session ------------------------------------------------------------
	const sm = ctx.sessionManager;
	const sessionId = safeText(() => sm.getSessionId());
	const sessionFile = safeText(() => sm.getSessionFile() ?? "");
	const cwd = safeText(() => sm.getCwd()) ?? ctx.cwd;
	const name = safeText(() => sm.getSessionName() ?? "");
	const leafId = safeText(() => sm.getLeafId() ?? "");
	lines.push(`session:    id=${sessionId ?? "?"}${name ? `  name=${name}` : ""}`);
	lines.push(`            file=${sessionFile || "<in-memory>"}`);
	lines.push(`cwd:        ${cwd}`);

	// -- Mode / trust / idleness -------------------------------------------
	const idle = safeValue(() => ctx.isIdle());
	const trusted = safeValue(() => ctx.isProjectTrusted());
	const pending = safeValue(() => ctx.hasPendingMessages());
	lines.push(`mode:       ${ctx.mode}  ui=${ctx.hasUI ? "yes" : "no"}`);
	lines.push(`trust:      projectTrusted=${trusted === undefined ? "unavailable" : String(trusted)}`);
	lines.push(`idle:       ${idle === undefined ? "unavailable" : String(idle)}  pendingMessages=${
		pending === undefined ? "unavailable" : String(pending)
	}`);

	// -- Model / thinking ---------------------------------------------------
	if (ctx.model) {
		lines.push(`model:      ${ctx.model.provider}/${ctx.model.id}`);
	} else {
		lines.push("model:      unavailable (no active model on context)");
	}
	lines.push(`thinking:   ${ctx.thinkingLevel ?? "unavailable"}`);

	// -- Context usage ------------------------------------------------------
	const usage = safeValue(() => ctx.getContextUsage());
	if (usage) {
		const fraction = contextPercentToFraction(usage.percent);
		lines.push(
			`context:    ${usage.tokens === null ? "unknown tokens" : formatCount(usage.tokens)}/${formatCount(usage.contextWindow)} tokens (${formatContextPercent(usage.percent)})`,
		);
		lines.push(`            ${fraction === null ? "percent unavailable" : renderBar(fraction, 40)}`);
	} else {
		lines.push("context:    unavailable (ctx.getContextUsage() returned undefined)");
	}

	// -- Active tools / branch ---------------------------------------------
	const activeTools = safeValue(() => deps.pi.getActiveTools());
	const allTools = safeValue(() => deps.pi.getAllTools());
	lines.push(
		`tools:      active=${activeTools ? activeTools.length : "unavailable"}  all=${
			allTools ? allTools.length : "unavailable"
		}`,
	);

	const branch = safeValue(() => ctx.sessionManager.getBranch());
	const entries = safeValue(() => ctx.sessionManager.getEntries());
	const tree = safeValue(() => ctx.sessionManager.getTree());
	lines.push(
		`branch:     entries=${branch ? branch.length : "unavailable"}  leaf=${leafId || "?"}  ` +
			`treeRoots=${tree ? tree.length : "unavailable"}  totalEntries=${entries ? entries.length : "unavailable"}`,
	);

	// -- Trace / metrics ----------------------------------------------------
	const metrics = deps.runtime.trace.snapshotMetrics();
	lines.push(
		`trace:      ${deps.runtime.trace.isEnabled() ? "on" : "off"}  recorded=${formatCount(metrics.events.recorded)}  ` +
			`dropped=${formatCount(metrics.events.dropped)}  capacity=${formatCount(deps.runtime.trace.ring.capacity)}`,
	);
	lines.push(
		`runs:       started=${metrics.runs.started} ended=${metrics.runs.ended} settled=${metrics.runs.settled} ` +
			`active=${metrics.runs.active}  turns=${metrics.turns}`,
	);
	lines.push(
		`toolCalls:  completed=${metrics.tools.completed} errors=${metrics.tools.errors} ` +
			`errorRate=${formatPercent(metrics.tools.errorRate)}`,
	);

	// -- MCP ----------------------------------------------------------------
	lines.push(`mcp:        ${mcpStatusLine(deps)}`);

	lines.push(SEPARATOR);
	lines.push("read-only: these numbers never enter the model context or transcript.");
	return { title: "/debug status", lines };
};

function safeText(fn: () => string | undefined): string | undefined {
	const result = safeValue(fn);
	if (result === undefined) return undefined;
	return result === "" ? "" : result;
}

function safeValue<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}
