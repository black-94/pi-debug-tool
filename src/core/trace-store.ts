import { type Clock, systemClock } from "./clock";
import { MetricsCollector } from "./metrics";
import { RingBuffer } from "./ring-buffer";
import type { MetricsSnapshot, TraceEvent, TraceKind, ToolObservation } from "./types";

export interface TraceStoreOptions {
	/** Ring buffer capacity. Older entries are evicted with a dropped counter. */
	capacity?: number;
	clock?: Clock;
}

export const DEFAULT_RING_CAPACITY = 2000;

interface RecordPatch {
	runId?: number;
	turnIndex?: number;
	requestId?: number;
	messageSeq?: number;
	toolCallId?: string;
	durationMs?: number;
	data?: Record<string, unknown>;
}

/**
 * In-memory trace + metrics store.
 *
 * Invariants:
 * - Only metadata is ever stored (sizes, counts, ids, durations). No tool
 *   arguments/results, prompt text, thinking text, or image bytes.
 * - Ring-buffer entries are recorded only while tracing is enabled; counters
 *   and tool durations are lightweight metadata and are always maintained so
 *   `/debug stats` works without pre-enabling tracing.
 * - No Pi API is called from here; this object is pure bookkeeping.
 */
export class TraceStore {
	readonly ring: RingBuffer<TraceEvent>;
	readonly metrics = new MetricsCollector();
	private readonly clock: Clock;
	private enabled = false;
	private seq = 0;
	private runSeq = 0;
	private messageSeq = 0;
	private requestSeq = 0;
	private currentRunId: number | undefined;
	private currentTurnIndex: number | undefined;
	private readonly tools = new Map<string, ToolObservation>();

	constructor(options: TraceStoreOptions = {}) {
		this.ring = new RingBuffer<TraceEvent>(options.capacity ?? DEFAULT_RING_CAPACITY);
		this.clock = options.clock ?? systemClock;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	get currentRun(): number | undefined {
		return this.currentRunId;
	}

	get currentTurn(): number | undefined {
		return this.currentTurnIndex;
	}

	/** Record a discrete event. Returns the event; pushes to the ring only when enabled. */
	record(kind: TraceKind, name: string, patch: RecordPatch = {}): TraceEvent {
		this.seq += 1;
		const event: TraceEvent = {
			seq: this.seq,
			wallTime: this.clock.wallNow(),
			monoTime: this.clock.monoNow(),
			kind,
			name,
			runId: patch.runId ?? this.currentRunId,
			turnIndex: patch.turnIndex ?? this.currentTurnIndex,
			requestId: patch.requestId,
			messageSeq: patch.messageSeq,
			toolCallId: patch.toolCallId,
			durationMs: patch.durationMs,
			data: patch.data,
		};
		if (this.enabled) {
			this.ring.push(event);
		}
		return event;
	}

	/** Metric-only counter for high-frequency events that must not fill the ring. */
	bump(name: string, amount = 1): void {
		this.metrics.bumpCounter(name, amount);
	}

	noteRunStart(): number {
		this.runSeq += 1;
		this.currentRunId = this.runSeq;
		this.currentTurnIndex = undefined;
		this.metrics.noteRunStart();
		return this.runSeq;
	}

	noteRunEnd(): void {
		this.metrics.noteRunEnd();
	}

	noteRunSettled(): void {
		this.metrics.noteRunSettled();
	}

	noteTurn(turnIndex: number): void {
		this.currentTurnIndex = turnIndex;
		this.metrics.noteTurn();
	}

	noteRequest(): number {
		this.requestSeq += 1;
		this.metrics.noteRequest();
		return this.requestSeq;
	}

	noteMessage(): number {
		this.messageSeq += 1;
		return this.messageSeq;
	}

	/** Register the start of a tool call; returns the observation record. */
	beginTool(toolCallId: string, toolName: string, argsBytes?: number): ToolObservation {
		const observation: ToolObservation = {
			toolCallId,
			toolName,
			runId: this.currentRunId,
			turnIndex: this.currentTurnIndex,
			startWall: this.clock.wallNow(),
			startMono: this.clock.monoNow(),
			argsBytes,
			finished: false,
		};
		this.tools.set(toolCallId, observation);
		return observation;
	}

	/** Complete a tool call; returns its duration in ms when it had a start. */
	endTool(toolCallId: string, resultBytes: number | undefined, isError: boolean): ToolObservation | undefined {
		const observation = this.tools.get(toolCallId);
		if (!observation || observation.finished) return undefined;
		const endMono = this.clock.monoNow();
		observation.endWall = this.clock.wallNow();
		observation.endMono = endMono;
		observation.durationMs = Math.max(0, endMono - observation.startMono);
		observation.resultBytes = resultBytes;
		observation.isError = isError;
		observation.finished = true;
		return observation;
	}

	getTool(toolCallId: string): ToolObservation | undefined {
		return this.tools.get(toolCallId);
	}

	getToolObservations(): ToolObservation[] {
		return [...this.tools.values()];
	}

	/** Clear trace/metrics/tool state. Does not touch the session or MCP cache. */
	clear(): void {
		this.ring.clear();
		this.metrics.reset();
		this.tools.clear();
		this.currentRunId = undefined;
		this.currentTurnIndex = undefined;
	}

	/** Full teardown used on session shutdown/reload. */
	resetForShutdown(): void {
		this.clear();
		this.enabled = false;
	}

	events(): TraceEvent[] {
		return this.ring.toArray();
	}

	eventsLast(limit: number): TraceEvent[] {
		return this.ring.last(limit);
	}

	snapshotMetrics(): MetricsSnapshot {
		return this.metrics.snapshot(this.enabled, this.ring.size, this.ring.dropped);
	}
}
