import { type Clock, systemClock } from "./core/clock";
import { McpCallStats } from "./core/mcp-native";
import { DEFAULT_RING_CAPACITY, TraceStore } from "./core/trace-store";

/**
 * All mutable state owned by the debug extension.
 *
 * It lives entirely in memory and is never handed to Pi. MCP state is limited to
 * `McpCallStats`, which records metadata about observed native MCP tool calls
 * (counts, durations, concurrency, parent correlation). It never stores MCP
 * server definitions, transports, headers, env, credentials, tool arguments, or
 * results, and the extension never connects, starts, or reconnects a server.
 */
export interface DebugRuntime {
	readonly clock: Clock;
	readonly trace: TraceStore;
	/** Metadata-only aggregation of native MCP tool calls. */
	readonly mcpCalls: McpCallStats;
}

export interface DebugRuntimeOptions {
	clock?: Clock;
	ringCapacity?: number;
}

export function createRuntime(options: DebugRuntimeOptions = {}): DebugRuntime {
	const clock = options.clock ?? systemClock;
	return {
		clock,
		trace: new TraceStore({ capacity: options.ringCapacity ?? DEFAULT_RING_CAPACITY, clock }),
		mcpCalls: new McpCallStats(),
	};
}
