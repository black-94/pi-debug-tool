import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasMcpToolPrefix } from "./core/mcp-native";
import { byteSize } from "./core/redaction";
import type { UsageLike } from "./core/metrics";
import type { DebugRuntime } from "./runtime";

/**
 * Observer-only event wiring.
 *
 * Every handler here:
 * - returns `undefined` (explicitly), so it can never replace a payload, block
 *   a tool call, append an entry, or request a continuation;
 * - never mutates the event or context;
 * - swallows its own errors so a debug bug cannot affect Pi.
 *
 * Only metadata (sizes, counts, ids, levels, statuses) is recorded. Message
 * bodies, thinking text, image bytes, and provider payloads are never stored.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asUsage(value: unknown): UsageLike | undefined {
	if (!isRecord(value)) return undefined;
	const cost = isRecord(value.cost) ? num(value.cost.total) : undefined;
	return {
		input: num(value.input),
		output: num(value.output),
		cacheRead: num(value.cacheRead),
		cacheWrite: num(value.cacheWrite),
		totalTokens: num(value.totalTokens),
		cost: cost === undefined ? undefined : { total: cost },
	};
}

interface MessageShape {
	role: string;
	bytes: number;
	usage?: UsageLike;
	isError?: boolean;
	toolName?: string;
	blocks: { text: number; image: number; thinking: number; toolCall: number; other: number };
}

function describeMessage(message: unknown): MessageShape {
	if (typeof message === "string") {
		return { role: "unknown", bytes: byteSize(message), blocks: emptyBlocks() };
	}
	const rec = isRecord(message) ? message : {};
	const role = typeof rec.role === "string" ? rec.role : "unknown";
	const blocks = emptyBlocks();
	let bytes = 0;
	const content = rec.content;
	if (typeof content === "string") {
		blocks.text += 1;
		bytes += byteSize(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRecord(block)) {
				blocks.other += 1;
				continue;
			}
			const type = typeof block.type === "string" ? block.type : "other";
			if (type === "text") {
				blocks.text += 1;
				bytes += byteSize(block.text);
			} else if (type === "thinking") {
				blocks.thinking += 1;
				bytes += byteSize(block.thinking);
			} else if (type === "image") {
				blocks.image += 1;
				bytes += typeof block.data === "string" ? block.data.length : 0;
			} else if (type === "toolCall") {
				blocks.toolCall += 1;
				bytes += byteSize(block.arguments);
			} else {
				blocks.other += 1;
			}
		}
	}
	return {
		role,
		bytes,
		usage: asUsage(rec.usage),
		isError: rec.isError === true,
		toolName: typeof rec.toolName === "string" ? rec.toolName : undefined,
		blocks,
	};
}

function emptyBlocks(): MessageShape["blocks"] {
	return { text: 0, image: 0, thinking: 0, toolCall: 0, other: 0 };
}

type ObserverFn = (event: Record<string, unknown>, ctx: ExtensionContext) => void;

/**
 * Wrap a handler so it always returns `undefined` and never throws.
 * The returned function's only effect is recording into the local runtime.
 */
function observer(runtime: DebugRuntime, fn: ObserverFn): (event: unknown, ctx: ExtensionContext) => undefined {
	return (event: unknown, ctx: ExtensionContext): undefined => {
		try {
			fn(isRecord(event) ? event : {}, ctx);
		} catch {
			runtime.trace.metrics.noteInternalError();
		}
		return undefined;
	};
}

export function registerObservers(pi: ExtensionAPI, runtime: DebugRuntime): void {
	const { trace } = runtime;

	// -- Session lifecycle ---------------------------------------------------
	pi.on(
		"session_start",
		observer(runtime, (event, _ctx) => {
			// Fresh session: drop the previous session's trace/metrics/MCP call
			// metadata but keep the user's tracing preference.
			trace.clear();
			runtime.mcpCalls.reset();
			trace.record("session", "session_start", { data: { reason: event?.reason ?? "unknown" } });
		}),
	);

	pi.on(
		"session_shutdown",
		observer(runtime, (event, _ctx) => {
			trace.record("session", "session_shutdown", { data: { reason: event?.reason ?? "unknown" } });
			runtime.mcpCalls.reset();
			trace.resetForShutdown();
		}),
	);

	// -- Compaction ----------------------------------------------------------
	pi.on(
		"session_before_compact",
		observer(runtime, (event, _ctx) => {
			trace.metrics.noteCompactionStart();
			trace.record("compaction", "session_before_compact", {
				data: {
					reason: typeof event.reason === "string" ? event.reason : "unknown",
					willRetry: event.willRetry === true,
					branchEntries: Array.isArray(event.branchEntries) ? event.branchEntries.length : 0,
				},
			});
		}),
	);

	pi.on(
		"session_compact",
		observer(runtime, (event, _ctx) => {
			trace.metrics.noteCompactionSuccess();
			const entry = isRecord(event.compactionEntry) ? event.compactionEntry : {};
			trace.record("compaction", "session_compact", {
				data: {
					reason: typeof event.reason === "string" ? event.reason : "unknown",
					tokensBefore: num(entry.tokensBefore) ?? null,
				},
			});
		}),
	);

	pi.on(
		"session_compact_failed",
		observer(runtime, (event, _ctx) => {
			trace.metrics.noteCompactionFailure();
			trace.record("compaction", "session_compact_failed", {
				data: {
					reason: typeof event.reason === "string" ? event.reason : "unknown",
					aborted: event.aborted === true,
					fromExtension: event.fromExtension === true,
				},
			});
		}),
	);

	// -- Agent run lifecycle -------------------------------------------------
	pi.on(
		"agent_start",
		observer(runtime, () => {
			const runId = trace.noteRunStart();
			trace.record("lifecycle", "agent_start", { runId });
		}),
	);

	pi.on(
		"agent_end",
		observer(runtime, (event) => {
			trace.metrics.noteRunEnd();
			trace.record("lifecycle", "agent_end", {
				data: { messages: Array.isArray(event.messages) ? event.messages.length : 0 },
			});
		}),
	);

	pi.on(
		"agent_settled",
		observer(runtime, () => {
			trace.metrics.noteRunSettled();
			trace.record("lifecycle", "agent_settled");
		}),
	);

	pi.on(
		"agent_before_settle",
		observer(runtime, (event) => {
			trace.record("lifecycle", "agent_before_settle", {
				data: {
					outcome: typeof event.outcome === "string" ? event.outcome : "unknown",
					canContinue: isRecord(event.context) ? event.context.canContinue === true : false,
				},
			});
		}),
	);

	pi.on(
		"turn_start",
		observer(runtime, (event) => {
			const turnIndex = num(event.turnIndex) ?? 0;
			trace.noteTurn(turnIndex);
			trace.record("lifecycle", "turn_start", { turnIndex });
		}),
	);

	pi.on(
		"turn_end",
		observer(runtime, (event) => {
			trace.record("lifecycle", "turn_end", {
				turnIndex: num(event.turnIndex) ?? undefined,
				data: {
					toolResults: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
				},
			});
		}),
	);

	// -- Prompt / provider ---------------------------------------------------
	pi.on(
		"before_agent_start",
		observer(runtime, (event) => {
			trace.record("provider", "before_agent_start", {
				data: {
					promptBytes: typeof event.prompt === "string" ? byteSize(event.prompt) : 0,
					imageCount: Array.isArray(event.images) ? event.images.length : 0,
					systemPromptBytes: typeof event.systemPrompt === "string" ? byteSize(event.systemPrompt) : 0,
				},
			});
		}),
	);

	pi.on(
		"before_provider_request",
		observer(runtime, (event) => {
			trace.metrics.noteProviderRequest();
			const requestId = trace.noteRequest();
			trace.record("provider", "before_provider_request", {
				requestId,
				data: { payloadBytes: byteSize(event.payload) },
			});
		}),
	);

	pi.on(
		"after_provider_response",
		observer(runtime, (event) => {
			const status = num(event.status) ?? 0;
			trace.metrics.noteProviderResponse(status);
			trace.record("provider", "after_provider_response", {
				data: {
					status,
					// Header values may contain credentials; only the count is kept.
					headerCount: isRecord(event.headers) ? Object.keys(event.headers).length : 0,
				},
			});
		}),
	);

	pi.on(
		"context",
		observer(runtime, (event) => {
			trace.record("provider", "context", {
				data: { messages: Array.isArray(event.messages) ? event.messages.length : 0 },
			});
		}),
	);

	pi.on(
		"context_with_system",
		observer(runtime, (event) => {
			trace.record("provider", "context_with_system", {
				data: { messages: Array.isArray(event.messages) ? event.messages.length : 0 },
			});
		}),
	);

	// -- Messages ------------------------------------------------------------
	pi.on(
		"message_start",
		observer(runtime, (event) => {
			const shape = describeMessage(event.message);
			const messageSeq = trace.noteMessage();
			trace.metrics.noteMessageStart(shape.role);
			trace.record("message", "message_start", {
				messageSeq,
				data: { role: shape.role, bytes: shape.bytes, blocks: shape.blocks },
			});
		}),
	);

	// Extremely high frequency: counters only, never ring entries.
	pi.on(
		"message_update",
		observer(runtime, () => {
			trace.metrics.noteMessageUpdate();
		}),
	);

	pi.on(
		"message_end",
		observer(runtime, (event) => {
			const shape = describeMessage(event.message);
			trace.metrics.noteMessageEnd();
			if (shape.role === "assistant") {
				trace.metrics.noteUsage(shape.usage);
			}
			trace.record("message", "message_end", {
				data: { role: shape.role, bytes: shape.bytes, blocks: shape.blocks, isError: shape.isError === true },
			});
		}),
	);

	// -- Tools ---------------------------------------------------------------
	pi.on(
		"tool_call",
		observer(runtime, (event) => {
			// Metadata only; never mutate event.input.
			trace.record("tool", "tool_call", {
				toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				data: {
					toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
					argsBytes: byteSize(event.input),
				},
			});
		}),
	);

	pi.on(
		"tool_execution_start",
		observer(runtime, (event) => {
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
			const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
			const parentToolCallId = typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined;
			if (hasMcpToolPrefix(toolName)) {
				runtime.mcpCalls.begin(toolCallId, toolName, parentToolCallId, runtime.clock.wallNow());
			}
			trace.beginTool(toolCallId, toolName, byteSize(event.args));
			trace.metrics.noteToolStart(toolName);
			trace.record("tool", "tool_execution_start", {
				toolCallId,
				data: {
					toolName,
					argsBytes: byteSize(event.args),
					// Present when a tool such as a codemode script issued this call.
					parentToolCallId: parentToolCallId ?? null,
				},
			});
		}),
	);

	pi.on(
		"tool_execution_update",
		observer(runtime, () => {
			trace.bump("tool_execution_update");
		}),
	);

	pi.on(
		"tool_execution_end",
		observer(runtime, (event) => {
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
			const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
			const parentToolCallId = typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined;
			const resultBytes = byteSize(event.result);
			const isError = event.isError === true;
			const observation = trace.endTool(toolCallId, resultBytes, isError);
			if (hasMcpToolPrefix(toolName)) {
				runtime.mcpCalls.end(
					toolCallId,
					toolName,
					isError,
					observation?.durationMs,
					runtime.clock.wallNow(),
				);
			}
			trace.metrics.noteToolEnd(toolName, observation?.durationMs ?? 0, isError);
			trace.record("tool", "tool_execution_end", {
				toolCallId,
				durationMs: observation?.durationMs,
				data: {
					toolName,
					resultBytes,
					isError,
					parentToolCallId: parentToolCallId ?? null,
				},
			});
		}),
	);

	pi.on(
		"tool_result",
		observer(runtime, (event) => {
			trace.record("tool", "tool_result", {
				toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
				data: {
					toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
					contentBytes: byteSize(event.content),
					isError: event.isError === true,
				},
			});
		}),
	);

	// -- Model / thinking / UI / cache --------------------------------------
	pi.on(
		"model_select",
		observer(runtime, (event) => {
			const model = isRecord(event.model) ? event.model : {};
			trace.record("model", "model_select", {
				data: {
					provider: typeof model.provider === "string" ? model.provider : "unknown",
					modelId: typeof model.id === "string" ? model.id : "unknown",
					source: typeof event.source === "string" ? event.source : "unknown",
				},
			});
		}),
	);

	pi.on(
		"thinking_level_select",
		observer(runtime, (event) => {
			trace.record("thinking", "thinking_level_select", {
				data: {
					level: typeof event.level === "string" ? event.level : "unknown",
					previousLevel: typeof event.previousLevel === "string" ? event.previousLevel : "unknown",
				},
			});
		}),
	);

	pi.on(
		"ui_prompt_start",
		observer(runtime, (event) => {
			trace.metrics.noteUiPromptStart();
			trace.record("ui", "ui_prompt_start", {
				data: { kind: typeof event.kind === "string" ? event.kind : "unknown" },
			});
		}),
	);

	pi.on(
		"ui_prompt_end",
		observer(runtime, (event) => {
			trace.metrics.noteUiPromptEnd();
			trace.record("ui", "ui_prompt_end", {
				data: { kind: typeof event.kind === "string" ? event.kind : "unknown" },
			});
		}),
	);

	pi.on(
		"cache_warming_decision",
		observer(runtime, (event) => {
			const action = typeof event.action === "string" ? event.action : undefined;
			trace.metrics.noteCacheDecision(action);
			trace.record("cache", "cache_warming_decision", {
				data: {
					action: action ?? null,
					warmCost: num(event.warmCost) ?? null,
					missCost: num(event.missCost) ?? null,
					continuationProbability: num(event.continuationProbability) ?? null,
				},
			});
		}),
	);
}
