import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDebugExtension } from "../src/extension";
import piDebugTool from "../extensions/debug";
import {
	createFakeClock,
	createFakeContextEvent,
	createFakePi,
	FORBIDDEN_METHODS,
	type FakePi,
} from "./helpers/fakes";

const SAMPLE_EVENTS: Record<string, unknown> = {
	session_start: { type: "session_start", reason: "startup" },
	session_shutdown: { type: "session_shutdown", reason: "quit" },
	session_before_compact: { type: "session_before_compact", reason: "manual", willRetry: false, branchEntries: [] },
	session_compact: { type: "session_compact", compactionEntry: { tokensBefore: 10 }, reason: "manual" },
	session_compact_failed: { type: "session_compact_failed", reason: "manual", aborted: true },
	agent_start: { type: "agent_start" },
	agent_end: { type: "agent_end", messages: [] },
	agent_settled: { type: "agent_settled" },
	agent_before_settle: {
		type: "agent_before_settle",
		outcome: "completed",
		context: { canContinue: false },
		entries: [],
		continue: false,
	},
	turn_start: { type: "turn_start", turnIndex: 0, timestamp: 1 },
	turn_end: { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] }, toolResults: [] },
	before_agent_start: { type: "before_agent_start", prompt: "hi", systemPrompt: "sys", systemPromptOptions: {} },
	before_provider_request: { type: "before_provider_request", payload: { model: "m", messages: [] } },
	after_provider_response: { type: "after_provider_response", status: 200, headers: { "x-api-key": "secret-value" } },
	context: { type: "context", messages: [] },
	context_with_system: { type: "context_with_system", messages: [] },
	message_start: { type: "message_start", message: { role: "user", content: "hi" } },
	message_update: { type: "message_update", message: {}, assistantMessageEvent: {} },
	message_end: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
	tool_call: { type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "/x", apiKey: "secret" } },
	tool_execution_start: { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/x" } },
	tool_execution_update: { type: "tool_execution_update", toolCallId: "t1", toolName: "read", args: {}, partialResult: {} },
	tool_execution_end: { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [] }, isError: false },
	tool_result: {
		type: "tool_result",
		toolCallId: "t1",
		toolName: "read",
		input: {},
		content: [{ type: "text", text: "data" }],
		isError: false,
	},
	model_select: { type: "model_select", model: { provider: "anthropic", id: "claude-x" }, source: "set" },
	thinking_level_select: { type: "thinking_level_select", level: "high", previousLevel: "medium" },
	ui_prompt_start: { type: "ui_prompt_start", kind: "confirm" },
	ui_prompt_end: { type: "ui_prompt_end", kind: "confirm" },
	cache_warming_decision: {
		type: "cache_warming_decision",
		warmCost: 0.001,
		missCost: 0.02,
		continuationProbability: 0.2,
		action: "stop",
	},
};

function setup(overrides: Parameters<typeof createFakePi>[0] = {}): FakePi {
	const fake = createFakePi(overrides);
	createDebugExtension(fake.pi, { clock: createFakeClock() });
	return fake;
}

describe("registration surface", () => {
	it("ships the same factory through the Pi entry point", () => {
		expect(typeof piDebugTool).toBe("function");
		const fake = createFakePi();
		piDebugTool(fake.pi);
		expect([...fake.commands.keys()]).toEqual(["debug"]);
		expect(fake.forbiddenCalls).toEqual([]);
	});

	it("registers exactly one command and no model-facing capabilities", () => {
		const fake = setup();
		expect([...fake.commands.keys()]).toEqual(["debug"]);
		expect(fake.commands.get("debug")?.description).toMatch(/Observer-only/);
		expect(fake.forbiddenCalls).toEqual([]);
	});

	it("never calls any context-polluting API", () => {
		const fake = setup();
		const used = fake.calls.map((call) => call.method);
		for (const forbidden of FORBIDDEN_METHODS) {
			expect(used).not.toContain(forbidden);
		}
	});

	it("subscribes to observer events but never to MCP server-change or adapter channels", () => {
		const fake = setup();
		expect([...fake.handlers.keys()].sort()).toEqual(
			[
				"after_provider_response",
				"agent_before_settle",
				"agent_end",
				"agent_settled",
				"agent_start",
				"before_agent_start",
				"before_provider_request",
				"cache_warming_decision",
				"context",
				"context_with_system",
				"message_end",
				"message_start",
				"message_update",
				"model_select",
				"session_before_compact",
				"session_compact",
				"session_compact_failed",
				"session_shutdown",
				"session_start",
				"thinking_level_select",
				"tool_call",
				"tool_execution_end",
				"tool_execution_start",
				"tool_execution_update",
				"tool_result",
				"turn_end",
				"turn_start",
				"ui_prompt_end",
				"ui_prompt_start",
			].sort(),
		);
		// Handling `mcp_servers_change` would mark this extension as the MCP
		// connector; it must never be registered.
		expect(fake.handlers.has("mcp_servers_change")).toBe(false);
		// The legacy adapter protocol is gone entirely.
		expect(fake.bus.handlers.has("pi-mcp-adapter/status/v1")).toBe(false);
		expect(fake.bus.emitCount).toBe(0);
	});
});

describe("observer handlers", () => {
	it("all return undefined for representative events", () => {
		const fake = setup();
		const ctx = createFakeContextEvent();
		for (const [event, handlers] of fake.handlers) {
			const payload = SAMPLE_EVENTS[event] ?? {};
			for (const handler of handlers) {
				const result = handler(payload, ctx);
				expect(result, `handler for ${event} returned a value`).toBeUndefined();
			}
		}
	});

	it("never mutate the event payload", () => {
		const fake = setup();
		const ctx = createFakeContextEvent();
		for (const [event, handlers] of fake.handlers) {
			const payload = SAMPLE_EVENTS[event] ?? {};
			const before = JSON.stringify(payload);
			for (const handler of handlers) handler(payload, ctx);
			expect(JSON.stringify(payload), `event ${event} was mutated`).toBe(before);
		}
	});

	it("swallow their own errors and count them", () => {
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		const ctx = createFakeContextEvent();
		const exploding = new Proxy(
			{},
			{
				get() {
					throw new Error("boom");
				},
				getPrototypeOf() {
					return Object.prototype;
				},
				ownKeys() {
					throw new Error("boom");
				},
			},
		);
		const handler = fake.handlers.get("tool_execution_start")?.[0];
		expect(handler).toBeDefined();
		expect(() => handler?.(exploding, ctx)).not.toThrow();
		expect(handler?.(exploding, ctx)).toBeUndefined();
		expect(runtime.trace.snapshotMetrics().internalErrors).toBeGreaterThan(0);
	});
});

describe("static safety scan", () => {
	it("contains no context-polluting API calls in source", () => {
		const files = collectTypeScriptFiles(join(process.cwd(), "src"));
		expect(files.length).toBeGreaterThan(0);
		const patterns: RegExp[] = [
			/\.registerTool\s*\(/,
			/\.setActiveTools\s*\(/,
			/\.sendMessage\s*\(/,
			/\.sendUserMessage\s*\(/,
			/\.appendEntry\s*\(/,
			/\.registerMessageRenderer\s*\(/,
			/\.registerEntryRenderer\s*\(/,
			/\.registerMarkdownTransformer\s*\(/,
			/\.registerProvider\s*\(/,
			/\.unregisterProvider\s*\(/,
			/\.registerShortcut\s*\(/,
			/\.registerFlag\s*\(/,
			/\.setSessionName\s*\(/,
			/\.setLabel\s*\(/,
			/\.setModel\s*\(/,
			/\.setThinkingLevel\s*\(/,
			/\.registerMcpServer\s*\(/,
			/\.unregisterMcpServer\s*\(/,
			/\.registerVirtualModel\s*\(/,
			/\.unregisterVirtualModel\s*\(/,
			/["']mcp_servers_change["']/,
			/node:child_process/,
			/\bchild_process\b/,
			/\.events\s*\.\s*emit\s*\(/,
			/\.persist\s*\(/,
			/\.appendMessage\s*\(/,
			/\.appendCustomEntry\s*\(/,
			/\.appendCustomMessageEntry\s*\(/,
		];
		const violations: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, "utf8");
			for (const pattern of patterns) {
				if (pattern.test(content)) {
					violations.push(`${file}: ${pattern}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});

function collectTypeScriptFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath ?? dir, entry.name));
}
