import type { MetricsSnapshot, TokenTotals, ToolStat } from "./types";

/**
 * Minimal structural view of Pi's `Usage`. Declared locally so the extension
 * never has to reach into Pi internals; any object with these fields works.
 */
export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number } | number;
}

export function emptyTokens(): TokenTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function addUsage(target: TokenTotals, usage: UsageLike | undefined): void {
	if (!usage) return;
	target.input += usage.input ?? 0;
	target.output += usage.output ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.cacheWrite += usage.cacheWrite ?? 0;
	target.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
	const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
	target.cost += cost ?? 0;
}

/** Per-tool duration reservoir is bounded so a chatty tool cannot grow memory. */
const DURATION_RESERVOIR = 200;

interface ToolAccumulator {
	calls: number;
	ends: number;
	errors: number;
	durations: number[];
}

/**
 * Counters derived strictly from observed public events.
 *
 * Denominator policy (documented in the README and asserted by tests):
 * - tool error rate = errors / completed tool executions (`tool_execution_end`).
 *   Started-but-not-finished calls are excluded so aborted batches do not
 *   dilute or inflate the rate.
 * - provider response counters are per HTTP status observed via
 *   `after_provider_response`; requests come from `before_provider_request`.
 */
export class MetricsCollector {
	private counters = new Map<string, number>();
	private runsStarted = 0;
	private runsEnded = 0;
	private runsSettled = 0;
	private turns = 0;
	private requests = 0;
	private messageStart = 0;
	private messageEnd = 0;
	private messageUpdates = 0;
	private messagesByRole = new Map<string, number>();
	private tools = new Map<string, ToolAccumulator>();
	private toolsStarted = 0;
	private toolsCompleted = 0;
	private toolErrors = 0;
	private usage = emptyTokens();
	private compactionStarted = 0;
	private compactionSucceeded = 0;
	private compactionFailed = 0;
	private providerRequests = 0;
	private providerResponses = 0;
	private providerResponsesByStatus = new Map<string, number>();
	private cacheDecisions = 0;
	private cacheWarm = 0;
	private cacheStop = 0;
	private uiPromptStart = 0;
	private uiPromptEnd = 0;
	private internalErrors = 0;

	bumpCounter(name: string, amount = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
	}

	noteRunStart(): void {
		this.runsStarted += 1;
	}

	noteRunEnd(): void {
		this.runsEnded += 1;
	}

	noteRunSettled(): void {
		this.runsSettled += 1;
	}

	noteTurn(): void {
		this.turns += 1;
	}

	noteRequest(): void {
		this.requests += 1;
	}

	noteMessageStart(role: string): void {
		this.messageStart += 1;
		this.messagesByRole.set(role, (this.messagesByRole.get(role) ?? 0) + 1);
	}

	noteMessageUpdate(): void {
		this.messageUpdates += 1;
	}

	noteMessageEnd(): void {
		this.messageEnd += 1;
	}

	noteToolStart(name: string): void {
		this.toolsStarted += 1;
		const acc = this.toolAccumulator(name);
		acc.calls += 1;
	}

	noteToolEnd(name: string, durationMs: number, isError: boolean): void {
		this.toolsCompleted += 1;
		if (isError) this.toolErrors += 1;
		const acc = this.toolAccumulator(name);
		acc.ends += 1;
		if (isError) acc.errors += 1;
		acc.durations.push(durationMs);
		if (acc.durations.length > DURATION_RESERVOIR) acc.durations.shift();
	}

	private toolAccumulator(name: string): ToolAccumulator {
		let acc = this.tools.get(name);
		if (!acc) {
			acc = { calls: 0, ends: 0, errors: 0, durations: [] };
			this.tools.set(name, acc);
		}
		return acc;
	}

	noteUsage(usage: UsageLike | undefined): void {
		addUsage(this.usage, usage);
	}

	noteCompactionStart(): void {
		this.compactionStarted += 1;
	}

	noteCompactionSuccess(): void {
		this.compactionSucceeded += 1;
	}

	noteCompactionFailure(): void {
		this.compactionFailed += 1;
	}

	noteProviderRequest(): void {
		this.providerRequests += 1;
	}

	noteProviderResponse(status: number): void {
		this.providerResponses += 1;
		const key = String(status);
		this.providerResponsesByStatus.set(key, (this.providerResponsesByStatus.get(key) ?? 0) + 1);
	}

	noteCacheDecision(action: string | undefined): void {
		this.cacheDecisions += 1;
		if (action === "warm") this.cacheWarm += 1;
		if (action === "stop") this.cacheStop += 1;
	}

	noteUiPromptStart(): void {
		this.uiPromptStart += 1;
	}

	noteUiPromptEnd(): void {
		this.uiPromptEnd += 1;
	}

	noteInternalError(): void {
		this.internalErrors += 1;
	}

	reset(): void {
		this.counters.clear();
		this.runsStarted = 0;
		this.runsEnded = 0;
		this.runsSettled = 0;
		this.turns = 0;
		this.requests = 0;
		this.messageStart = 0;
		this.messageEnd = 0;
		this.messageUpdates = 0;
		this.messagesByRole.clear();
		this.tools.clear();
		this.toolsStarted = 0;
		this.toolsCompleted = 0;
		this.toolErrors = 0;
		this.usage = emptyTokens();
		this.compactionStarted = 0;
		this.compactionSucceeded = 0;
		this.compactionFailed = 0;
		this.providerRequests = 0;
		this.providerResponses = 0;
		this.providerResponsesByStatus.clear();
		this.cacheDecisions = 0;
		this.cacheWarm = 0;
		this.cacheStop = 0;
		this.uiPromptStart = 0;
		this.uiPromptEnd = 0;
		this.internalErrors = 0;
	}

	snapshot(traceEnabled: boolean, recorded: number, dropped: number): MetricsSnapshot {
		const byName: ToolStat[] = [...this.tools.entries()]
			.map(([name, acc]) => {
				const sorted = [...acc.durations].sort((a, b) => a - b);
				const sum = sorted.reduce((total, value) => total + value, 0);
				return {
					name,
					calls: acc.calls,
					ends: acc.ends,
					errors: acc.errors,
					meanMs: sorted.length === 0 ? 0 : sum / sorted.length,
					p50Ms: percentile(sorted, 0.5),
					p95Ms: percentile(sorted, 0.95),
					maxMs: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
				};
			})
			.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

		return {
			traceEnabled,
			events: {
				recorded,
				dropped,
				counters: Object.fromEntries(this.counters),
			},
			runs: {
				started: this.runsStarted,
				ended: this.runsEnded,
				settled: this.runsSettled,
				active: Math.max(0, this.runsStarted - this.runsEnded),
			},
			turns: this.turns,
			requests: this.requests,
			messages: {
				start: this.messageStart,
				end: this.messageEnd,
				updates: this.messageUpdates,
				byRole: Object.fromEntries(this.messagesByRole),
			},
			tools: {
				completed: this.toolsCompleted,
				errors: this.toolErrors,
				errorRate: this.toolsCompleted === 0 ? null : this.toolErrors / this.toolsCompleted,
				started: this.toolsStarted,
				byName,
			},
			usage: { ...this.usage },
			compaction: {
				started: this.compactionStarted,
				succeeded: this.compactionSucceeded,
				failed: this.compactionFailed,
			},
			provider: {
				requests: this.providerRequests,
				responses: this.providerResponses,
				responsesByStatus: Object.fromEntries(this.providerResponsesByStatus),
			},
			cacheWarming: {
				decisions: this.cacheDecisions,
				warm: this.cacheWarm,
				stop: this.cacheStop,
			},
			ui: {
				promptStart: this.uiPromptStart,
				promptEnd: this.uiPromptEnd,
			},
			internalErrors: this.internalErrors,
		};
	}
}

/** Nearest-rank percentile over a pre-sorted array. */
export function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil(fraction * sorted.length);
	const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[index] as number;
}
