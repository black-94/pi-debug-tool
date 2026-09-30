import { summarizeProjection, summarizeSystemPromptOptions } from "../core/inspectors";
import { computeSessionMetrics } from "../core/session-metrics";
import { contextPercentToFraction, formatBytes, formatCost, formatContextPercent, formatCount, formatPercent, renderBar, renderTable } from "../core/format";
import { safe, type CommandDeps, type Subcommand } from "./deps";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TokenTotals } from "../core/types";
import type { MetricsSnapshot } from "../core/types";

const SEPARATOR = "─".repeat(58);

export const runStats: Subcommand = async (args, ctx, deps) => {
	const topic = (args.positionals[0] ?? "all").toLowerCase();
	const lines: string[] = [`pi-debug-tool — stats (${topic})`, SEPARATOR];

	switch (topic) {
		case "session":
			lines.push(...sessionLines(ctx));
			break;
		case "tools":
			lines.push(...toolLines(deps));
			break;
		case "cache":
			lines.push(...cacheLines(ctx, deps));
			break;
		case "context":
			lines.push(...contextLines(ctx));
			break;
		case "errors":
			lines.push(...errorLines(ctx, deps));
			break;
		case "all":
			lines.push("## session", ...sessionLines(ctx), "");
			lines.push("## tools", ...toolLines(deps), "");
			lines.push("## cache", ...cacheLines(ctx, deps), "");
			lines.push("## errors", ...errorLines(ctx, deps));
			break;
		default:
			lines.push(`unknown topic "${topic}". Use: session | tools | cache | context | errors`);
	}

	lines.push(SEPARATOR);
	lines.push("Denominators are stated explicitly per section; unavailable data is reported, never guessed.");
	return { title: `/debug stats ${topic}`, lines };
};

function sessionLines(ctx: ExtensionCommandContext): string[] {
	const entries = safe(() => ctx.sessionManager.getEntries());
	if (!entries.ok) return [`unavailable (${entries.error})`];
	const summary = computeSessionMetrics(entries.value as readonly unknown[]);
	const lines: string[] = [
		`entries: ${formatCount(summary.entriesTotal)}  ${formatTypeCounts(summary.entriesByType)}`,
		`messages: ${formatCount(summary.messages.total)}  ${formatRoleCounts(summary.messages.byRole)}`,
	];
	lines.push(`assistant usage (sum over assistant messages):`);
	lines.push(...usageLines(summary.assistantUsage));
	lines.push(
		`cache-warm usage entries: ${formatCount(summary.cacheWarmUsage.count)}  ` +
			`input=${formatCount(summary.cacheWarmUsage.usage.input)} output=${formatCount(summary.cacheWarmUsage.usage.output)} ` +
			`cost=${formatCost(summary.cacheWarmUsage.usage.cost)}`,
	);
	lines.push(
		`tool results: total=${formatCount(summary.toolResults.total)} errors=${formatCount(summary.toolResults.errors)} ` +
			`errorRate=${formatPercent(summary.toolResults.errorRate)} (errors / all toolResult messages)`,
	);
	lines.push(
		`compactions=${formatCount(summary.compactions)} branchSummaries=${formatCount(summary.branchSummaries)} ` +
			`contextEdits=${formatCount(summary.contextEdits)} modelChanges=${formatCount(summary.modelChanges)} ` +
			`thinkingChanges=${formatCount(summary.thinkingChanges)}`,
	);
	return lines;
}

function toolLines(deps: CommandDeps): string[] {
	const metrics: MetricsSnapshot = deps.runtime.trace.snapshotMetrics();
	const lines: string[] = [
		`completed=${formatCount(metrics.tools.completed)} started=${formatCount(metrics.tools.started)} ` +
			`errors=${formatCount(metrics.tools.errors)} errorRate=${formatPercent(metrics.tools.errorRate)}`,
		`denominator: tool error rate = errors / tool_execution_end count (started-but-unfinished calls excluded).`,
	];
	if (metrics.tools.byName.length === 0) {
		lines.push("no tool executions observed yet.");
		return lines;
	}
	const rows = metrics.tools.byName.map((stat) => [
		stat.name,
		String(stat.calls),
		String(stat.ends),
		String(stat.errors),
		`${stat.meanMs.toFixed(1)}ms`,
		`${stat.p50Ms.toFixed(1)}ms`,
		`${stat.p95Ms.toFixed(1)}ms`,
		`${stat.maxMs.toFixed(1)}ms`,
	]);
	lines.push(...renderTable(["tool", "calls", "ends", "errs", "mean", "p50", "p95", "max"], rows));
	lines.push("percentiles are nearest-rank over the last 200 durations per tool.");
	return lines;
}

function cacheLines(ctx: ExtensionCommandContext, deps: CommandDeps): string[] {
	const entries = safe(() => ctx.sessionManager.getEntries());
	const lines: string[] = [];
	if (!entries.ok) {
		lines.push(`session usage unavailable (${entries.error})`);
	} else {
		const summary = computeSessionMetrics(entries.value as readonly unknown[]);
		const usage = summary.assistantUsage;
		lines.push("observed assistant usage (from message usage, public API):");
		lines.push(...usageLines(usage));
		const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
		const readShare = denominator > 0 ? usage.cacheRead / denominator : null;
		const writeShare = denominator > 0 ? usage.cacheWrite / denominator : null;
		lines.push(
			`cacheReadShare=${formatPercent(readShare)} cacheWriteShare=${formatPercent(writeShare)} ` +
				`(denominator = input + cacheRead + cacheWrite; input counts non-cached prompt tokens)`,
		);
	}
	const metrics = deps.runtime.trace.snapshotMetrics();
	lines.push(
		`cache_warming_decision observed: decisions=${formatCount(metrics.cacheWarming.decisions)} ` +
			`warm=${formatCount(metrics.cacheWarming.warm)} stop=${formatCount(metrics.cacheWarming.stop)}`,
	);
	lines.push(
		"cache hit ratio is not computed: providers report cache reads/writes, not cache hit counts, and Pi exposes no such counter.",
	);
	return lines;
}

function contextLines(ctx: ExtensionCommandContext): string[] {
	const lines: string[] = [];
	const usage = safe(() => ctx.getContextUsage());
	if (!usage.ok || !usage.value) {
		lines.push(`context usage: unavailable${usage.ok ? "" : ` (${usage.error})`}`);
	} else {
		const value = usage.value;
		const fraction = contextPercentToFraction(value.percent);
		lines.push(
			`context usage: ${value.tokens === null ? "unknown tokens" : formatCount(value.tokens)}/${formatCount(value.contextWindow)} ` +
				`(${formatContextPercent(value.percent)})`,
		);
		lines.push(fraction === null ? "percent unavailable" : renderBar(fraction, 40));
	}
	const projection = safe(() => ctx.sessionManager.buildSessionProjection());
	if (!projection.ok) {
		lines.push(`projection: unavailable (${projection.error})`);
	} else {
		const summary = summarizeProjection(projection.value as unknown);
		lines.push(
			`projection: entries=${summary.projectedEntries} messages=${summary.messages} ` +
				`approxBytes=${formatBytes(summary.approximateBytes)}`,
		);
		lines.push(`projected model: ${summary.model ? `${summary.model.provider}/${summary.model.modelId}` : "unavailable"}`);
	}
	const options = safe(() => ctx.getSystemPromptOptions());
	if (options.ok) {
		const prompt = summarizeSystemPromptOptions(options.value);
		lines.push(
			`system prompt options: sections=${prompt.sectionNames.length} selectedTools=${prompt.selectedTools.length} ` +
				`contextFiles=${prompt.contextFiles.length}`,
		);
	} else {
		lines.push(`system prompt options: unavailable (${options.error})`);
	}
	return lines;
}

function errorLines(ctx: ExtensionCommandContext, deps: CommandDeps): string[] {
	const lines: string[] = [];
	const metrics = deps.runtime.trace.snapshotMetrics();
	lines.push(
		`tool errors: ${formatCount(metrics.tools.errors)}/${formatCount(metrics.tools.completed)} ` +
			`(${formatPercent(metrics.tools.errorRate)})`,
	);
	const statuses = Object.entries(metrics.provider.responsesByStatus).sort();
	lines.push(
		`provider responses by status: ${statuses.length === 0 ? "none observed" : statuses.map(([status, count]) => `${status}=${count}`).join("  ")}`,
	);
	lines.push(
		`compaction: started=${metrics.compaction.started} succeeded=${metrics.compaction.succeeded} failed=${metrics.compaction.failed}`,
	);
	lines.push(`debug-internal errors (swallowed): ${formatCount(metrics.internalErrors)}`);
	const entries = safe(() => ctx.sessionManager.getEntries());
	if (entries.ok) {
		const summary = computeSessionMetrics(entries.value as readonly unknown[]);
		lines.push(
			`session toolResult errors: ${formatCount(summary.toolResults.errors)}/${formatCount(summary.toolResults.total)} ` +
				`(${formatPercent(summary.toolResults.errorRate)})`,
		);
	} else {
		lines.push(`session toolResult errors: unavailable (${entries.error})`);
	}
	return lines;
}

function usageLines(usage: TokenTotals): string[] {
	return [
		`  input=${formatCount(usage.input)} output=${formatCount(usage.output)} ` +
			`cacheRead=${formatCount(usage.cacheRead)} cacheWrite=${formatCount(usage.cacheWrite)} totalTokens=${formatCount(usage.totalTokens)}`,
		`  cost=${formatCost(usage.cost)}`,
	];
}

function formatTypeCounts(counts: Record<string, number>): string {
	const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	if (entries.length === 0) return "(none)";
	return entries.map(([type, count]) => `${type}=${count}`).join(" ");
}

function formatRoleCounts(counts: Record<string, number>): string {
	const entries = Object.entries(counts);
	if (entries.length === 0) return "(none)";
	return entries.map(([role, count]) => `${role}=${count}`).join(" ");
}
