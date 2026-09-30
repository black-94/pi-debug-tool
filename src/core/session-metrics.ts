import { addUsage, emptyTokens, type UsageLike } from "./metrics";
import type { SessionMetrics } from "./types";

/**
 * Derive a conservative metrics summary from the session's public entries.
 *
 * This is a pure read over whatever `sessionManager.getEntries()` returns and
 * uses runtime narrowing instead of Pi's internal types, so it cannot depend on
 * non-public shape details. It works even while tracing is disabled.
 *
 * Denominator policy:
 * - tool error rate = errored `toolResult` messages / all `toolResult` messages.
 * - assistant usage is summed from assistant message `usage` only; cache-warm
 *   usage is reported separately (its own `type: "usage"` entries).
 */
export function computeSessionMetrics(entries: readonly unknown[]): SessionMetrics {
	const entriesByType: Record<string, number> = {};
	const messagesByRole: Record<string, number> = {};
	const assistantUsage = emptyTokens();
	const cacheWarmUsage = emptyTokens();
	const byName: Record<string, { calls: number; errors: number }> = {};
	let entriesTotal = 0;
	let messagesTotal = 0;
	let toolResultsTotal = 0;
	let toolResultsErrors = 0;
	let cacheWarmCount = 0;
	let compactions = 0;
	let branchSummaries = 0;
	let contextEdits = 0;
	let modelChanges = 0;
	let thinkingChanges = 0;

	for (const raw of entries) {
		if (!isRecord(raw)) continue;
		entriesTotal += 1;
		const type = asString(raw.type) ?? "unknown";
		entriesByType[type] = (entriesByType[type] ?? 0) + 1;

		if (type === "message") {
			const message = isRecord(raw.message) ? raw.message : undefined;
			const role = message ? (asString(message.role) ?? "unknown") : "unknown";
			messagesByRole[role] = (messagesByRole[role] ?? 0) + 1;
			messagesTotal += 1;
			if (role === "assistant" && message) {
				addUsage(assistantUsage, asUsage(message.usage));
			}
			if (role === "toolResult" && message) {
				toolResultsTotal += 1;
				const isError = message.isError === true;
				if (isError) toolResultsErrors += 1;
				const toolName = asString(message.toolName) ?? "unknown";
				const bucket = (byName[toolName] ??= { calls: 0, errors: 0 });
				bucket.calls += 1;
				if (isError) bucket.errors += 1;
			}
			continue;
		}

		if (type === "usage") {
			cacheWarmCount += 1;
			addUsage(cacheWarmUsage, asUsage(raw.usage));
			continue;
		}
		if (type === "compaction") {
			compactions += 1;
			continue;
		}
		if (type === "branch_summary") {
			branchSummaries += 1;
			continue;
		}
		if (type === "context_edit") {
			contextEdits += 1;
			continue;
		}
		if (type === "model_change") {
			modelChanges += 1;
			continue;
		}
		if (type === "thinking_level_change") {
			thinkingChanges += 1;
			continue;
		}
	}

	return {
		entriesTotal,
		entriesByType,
		messages: { total: messagesTotal, byRole: messagesByRole },
		assistantUsage,
		cacheWarmUsage: { count: cacheWarmCount, usage: cacheWarmUsage },
		toolResults: {
			total: toolResultsTotal,
			errors: toolResultsErrors,
			errorRate: toolResultsTotal === 0 ? null : toolResultsErrors / toolResultsTotal,
			byName,
		},
		compactions,
		branchSummaries,
		contextEdits,
		modelChanges,
		thinkingChanges,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asUsage(value: unknown): UsageLike | undefined {
	if (!isRecord(value)) return undefined;
	const cost = isRecord(value.cost) ? (value.cost as Record<string, unknown>) : undefined;
	return {
		input: asNumber(value.input),
		output: asNumber(value.output),
		cacheRead: asNumber(value.cacheRead),
		cacheWrite: asNumber(value.cacheWrite),
		totalTokens: asNumber(value.totalTokens),
		cost: cost ? { total: asNumber(cost.total) } : undefined,
	};
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
