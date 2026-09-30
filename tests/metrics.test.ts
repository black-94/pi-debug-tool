import { describe, expect, it } from "vitest";
import { addUsage, emptyTokens, MetricsCollector, percentile } from "../src/core/metrics";
import { computeSessionMetrics } from "../src/core/session-metrics";
import { DEFAULT_ENTRIES } from "./helpers/fakes";

describe("usage helpers", () => {
	it("sums token and cost fields", () => {
		const totals = emptyTokens();
		addUsage(totals, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.5 } });
		addUsage(totals, { input: 1, output: 1, totalTokens: 2, cost: 0.25 });
		expect(totals).toEqual({
			input: 11,
			output: 6,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 20,
			cost: 0.75,
		});
	});

	it("tolerates missing fields", () => {
		const totals = emptyTokens();
		addUsage(totals, undefined);
		expect(totals.cost).toBe(0);
	});
});

describe("percentile", () => {
	it("uses nearest-rank on sorted input", () => {
		const sorted = [1, 2, 3, 4, 5];
		expect(percentile(sorted, 0.5)).toBe(3);
		expect(percentile(sorted, 0.95)).toBe(5);
		expect(percentile([], 0.5)).toBe(0);
	});
});

describe("MetricsCollector tool denominators", () => {
	it("computes the error rate over completed calls, not starts", () => {
		const metrics = new MetricsCollector();
		metrics.noteToolStart("bash");
		metrics.noteToolStart("bash");
		metrics.noteToolStart("grep");
		metrics.noteToolEnd("bash", 10, false);
		metrics.noteToolEnd("bash", 20, true);
		// grep started but never finished (aborted batch) -> excluded from both sides.

		const snapshot = metrics.snapshot(false, 0, 0);
		expect(snapshot.tools.started).toBe(3);
		expect(snapshot.tools.completed).toBe(2);
		expect(snapshot.tools.errors).toBe(1);
		expect(snapshot.tools.errorRate).toBe(0.5);
		const bash = snapshot.tools.byName.find((stat) => stat.name === "bash");
		expect(bash?.calls).toBe(2);
		expect(bash?.ends).toBe(2);
		expect(bash?.errors).toBe(1);
		expect(bash?.meanMs).toBe(15);
		expect(bash?.maxMs).toBe(20);
	});

	it("returns a null error rate when nothing completed", () => {
		const metrics = new MetricsCollector();
		metrics.noteToolStart("bash");
		expect(metrics.snapshot(false, 0, 0).tools.errorRate).toBeNull();
	});

	it("counts runs, messages, providers, cache decisions and errors", () => {
		const metrics = new MetricsCollector();
		metrics.noteRunStart();
		metrics.noteRunEnd();
		metrics.noteRunSettled();
		metrics.noteTurn();
		metrics.noteMessageStart("assistant");
		metrics.noteMessageUpdate();
		metrics.noteMessageEnd();
		metrics.noteProviderRequest();
		metrics.noteProviderResponse(200);
		metrics.noteProviderResponse(429);
		metrics.noteCacheDecision("warm");
		metrics.noteCacheDecision("stop");
		metrics.noteInternalError();

		const snapshot = metrics.snapshot(true, 3, 1);
		expect(snapshot.runs).toEqual({ started: 1, ended: 1, settled: 1, active: 0 });
		expect(snapshot.turns).toBe(1);
		expect(snapshot.messages).toMatchObject({ start: 1, end: 1, updates: 1, byRole: { assistant: 1 } });
		expect(snapshot.provider.responsesByStatus).toEqual({ "200": 1, "429": 1 });
		expect(snapshot.cacheWarming).toEqual({ decisions: 2, warm: 1, stop: 1 });
		expect(snapshot.internalErrors).toBe(1);
		expect(snapshot.traceEnabled).toBe(true);
		expect(snapshot.events).toMatchObject({ recorded: 3, dropped: 1 });
	});

	it("resets all aggregates", () => {
		const metrics = new MetricsCollector();
		metrics.noteToolStart("bash");
		metrics.noteToolEnd("bash", 1, true);
		metrics.noteRunStart();
		metrics.reset();
		const snapshot = metrics.snapshot(false, 0, 0);
		expect(snapshot.tools.completed).toBe(0);
		expect(snapshot.runs.started).toBe(0);
		expect(snapshot.tools.byName).toEqual([]);
	});
});

describe("computeSessionMetrics", () => {
	it("derives usage and tool results from public entries", () => {
		const summary = computeSessionMetrics(DEFAULT_ENTRIES);
		expect(summary.entriesTotal).toBe(4);
		expect(summary.entriesByType).toEqual({ message: 3, usage: 1 });
		expect(summary.messages.total).toBe(3);
		expect(summary.messages.byRole).toEqual({ user: 1, assistant: 1, toolResult: 1 });
		expect(summary.assistantUsage).toMatchObject({ input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: 0.001 });
		expect(summary.cacheWarmUsage.count).toBe(1);
		expect(summary.cacheWarmUsage.usage).toMatchObject({ input: 5, cacheRead: 50, cost: 0.0002 });
		expect(summary.toolResults).toMatchObject({ total: 1, errors: 0, errorRate: 0 });
		expect(summary.toolResults.byName).toEqual({ read: { calls: 1, errors: 0 } });
	});

	it("computes the toolResult error rate with errors / results", () => {
		const summary = computeSessionMetrics([
			{ type: "message", message: { role: "toolResult", toolName: "read", isError: false } },
			{ type: "message", message: { role: "toolResult", toolName: "read", isError: true } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true } },
		]);
		expect(summary.toolResults.total).toBe(3);
		expect(summary.toolResults.errors).toBe(2);
		expect(summary.toolResults.errorRate).toBeCloseTo(2 / 3);
		expect(summary.toolResults.byName).toEqual({
			read: { calls: 2, errors: 1 },
			bash: { calls: 1, errors: 1 },
		});
	});

	it("counts compaction, branch summary, context edit, model and thinking entries", () => {
		const summary = computeSessionMetrics([
			{ type: "compaction" },
			{ type: "branch_summary" },
			{ type: "context_edit" },
			{ type: "model_change" },
			{ type: "thinking_level_change" },
		]);
		expect(summary).toMatchObject({
			compactions: 1,
			branchSummaries: 1,
			contextEdits: 1,
			modelChanges: 1,
			thinkingChanges: 1,
		});
	});

	it("returns null rates and zero totals for an empty session", () => {
		const summary = computeSessionMetrics([]);
		expect(summary.toolResults.errorRate).toBeNull();
		expect(summary.messages.total).toBe(0);
		expect(summary.assistantUsage.cost).toBe(0);
	});

	it("ignores malformed entries without throwing", () => {
		const summary = computeSessionMetrics([null, 42, "nope", { type: "message" }, { type: "message", message: 7 }]);
		expect(summary.entriesTotal).toBe(2);
	});
});
