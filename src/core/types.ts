/**
 * Shared, dependency-free types for the observer-only debug extension.
 *
 * Everything in this file is local bookkeeping. None of it is ever handed to
 * the model-facing runtime, imported into a prompt, or persisted into the
 * session: the extension only reads Pi's public APIs and writes to its own
 * in-memory ring buffer.
 */

/** Coarse classification used by trace/timeline/stats rendering. */
export type TraceKind =
	| "lifecycle"
	| "provider"
	| "tool"
	| "message"
	| "compaction"
	| "model"
	| "thinking"
	| "ui"
	| "cache"
	| "session";

/** Truncated, redacted metadata safe to keep in memory and to export. */
export type SafeMetadata = Record<string, unknown>;

/**
 * One recorded observation.
 *
 * Correlation ids are always explicit:
 * - `runId`/`requestId`/`messageSeq` are local counters because Pi's public
 *   events do not expose native ids for them.
 * - `turnIndex` comes from `turn_start`/`turn_end`.
 * - `toolCallId` is Pi's native tool call id.
 */
export interface TraceEvent {
	seq: number;
	/** Wall-clock ms (Date.now). */
	wallTime: number;
	/** Monotonic ms (performance.now), used for durations only. */
	monoTime: number;
	kind: TraceKind;
	/** Event name as delivered by Pi, e.g. "tool_execution_start". */
	name: string;
	runId?: number;
	turnIndex?: number;
	requestId?: number;
	messageSeq?: number;
	toolCallId?: string;
	/** Duration in ms when the event closes a paired operation. */
	durationMs?: number;
	data?: SafeMetadata;
}

/** Paired start/end observation for one tool call (supports parallel calls). */
export interface ToolObservation {
	toolCallId: string;
	toolName: string;
	runId?: number;
	turnIndex?: number;
	startWall: number;
	startMono: number;
	endWall?: number;
	endMono?: number;
	durationMs?: number;
	argsBytes?: number;
	resultBytes?: number;
	isError?: boolean;
	finished: boolean;
}

export interface ToolStat {
	name: string;
	calls: number;
	ends: number;
	errors: number;
	/** Mean duration over completed calls, ms. */
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** Metrics collected purely from observed public events. */
export interface MetricsSnapshot {
	traceEnabled: boolean;
	events: {
		recorded: number;
		dropped: number;
		counters: Record<string, number>;
	};
	runs: {
		started: number;
		ended: number;
		settled: number;
		active: number;
	};
	turns: number;
	requests: number;
	messages: {
		start: number;
		end: number;
		updates: number;
		byRole: Record<string, number>;
	};
	tools: {
		/** Denominator for the error rate: number of observed tool completions. */
		completed: number;
		errors: number;
		/** errors / completed, or null when completed === 0. */
		errorRate: number | null;
		started: number;
		byName: ToolStat[];
	};
	usage: TokenTotals;
	compaction: {
		started: number;
		succeeded: number;
		failed: number;
	};
	provider: {
		requests: number;
		responses: number;
		responsesByStatus: Record<string, number>;
	};
	cacheWarming: {
		decisions: number;
		warm: number;
		stop: number;
	};
	ui: {
		promptStart: number;
		promptEnd: number;
	};
	internalErrors: number;
}

/** Read-only derivation over session entries (works even with tracing off). */
export interface SessionMetrics {
	entriesTotal: number;
	entriesByType: Record<string, number>;
	messages: {
		total: number;
		byRole: Record<string, number>;
	};
	assistantUsage: TokenTotals;
	/** Usage entries appended by the cache warmer (`type: "usage"`). */
	cacheWarmUsage: {
		count: number;
		usage: TokenTotals;
	};
	toolResults: {
		total: number;
		errors: number;
		errorRate: number | null;
		byName: Record<string, { calls: number; errors: number }>;
	};
	compactions: number;
	branchSummaries: number;
	contextEdits: number;
	modelChanges: number;
	thinkingChanges: number;
}
