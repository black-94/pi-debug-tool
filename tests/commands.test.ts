import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDebugArgumentCompletions } from "../src/commands";
import { readInventory, readMcpCommandProvider } from "../src/commands/mcp";
import { createDebugExtension } from "../src/extension";
import { createRuntime } from "../src/runtime";
import {
	createFakeClock,
	createFakeContext,
	createFakeContextEvent,
	createFakePi,
	makeCommand,
	makeMcpTool,
	type Call,
	type FakePi,
} from "./helpers/fakes";

function messageOf(call: Call | undefined): string {
	const [message] = call?.args ?? [];
	return typeof message === "string" ? message : "";
}

function lastNotify(uiCalls: Call[]): Call | undefined {
	return [...uiCalls].reverse().find((call) => call.method === "notify");
}

describe("command dispatch", () => {
	let fake: FakePi;

	beforeEach(() => {
		fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
	});

	async function invoke(command: string): Promise<{ uiCalls: Call[] }> {
		const { ctx, uiCalls } = createFakeContext({ mode: "print", hasUI: false });
		const commandHandler = fake.commands.get("debug")?.handler;
		await commandHandler?.(command, ctx);
		return { uiCalls };
	}

	it("defaults to status and reports read-only semantics", async () => {
		const { uiCalls } = await invoke("");
		const text = messageOf(lastNotify(uiCalls));
		expect(text).toContain("observer-only debug status");
		expect(text).toContain("read-only");
	});

	it("reports unknown subcommands without throwing", async () => {
		const { uiCalls } = await invoke("nope");
		expect(messageOf(lastNotify(uiCalls))).toContain('unknown subcommand "nope"');
	});

	it("toggles tracing with trace on/off and reports status", async () => {
		await invoke("trace on");
		expect(messageOf(lastNotify((await invoke("trace status")).uiCalls))).toContain("state:     on");
		await invoke("trace off");
		expect(messageOf(lastNotify((await invoke("trace status")).uiCalls))).toContain("state:     off");
	});

	it("clears only local trace/metrics and keeps tracing enabled", async () => {
		const localFake = createFakePi();
		const runtime = createDebugExtension(localFake.pi, { clock: createFakeClock() });
		runtime.trace.setEnabled(true);
		runtime.trace.record("lifecycle", "agent_start");
		expect(runtime.trace.ring.size).toBe(1);

		const { ctx, uiCalls } = createFakeContext({ mode: "print" });
		await localFake.commands.get("debug")?.handler("clear", ctx);

		expect(runtime.trace.ring.size).toBe(0);
		expect(runtime.trace.isEnabled()).toBe(true);
		expect(messageOf(lastNotify(uiCalls))).toContain("untouched");
	});

	it("reports stats with explicit denominators", async () => {
		const { uiCalls } = await invoke("stats tools");
		const text = messageOf(lastNotify(uiCalls));
		expect(text).toContain("denominator: tool error rate = errors / tool_execution_end count");
	});

	it("reports the cache accounting with an explicit denominator", async () => {
		const { uiCalls } = await invoke("stats cache");
		const text = messageOf(lastNotify(uiCalls));
		// Default fixture usage: input=100, cacheRead=30, cacheWrite=10.
		expect(text).toContain("cacheReadShare=21.4%");
		expect(text).toContain("cacheWriteShare=7.1%");
		expect(text).toContain("denominator = input + cacheRead + cacheWrite");
		expect(text).toContain("cache hit ratio is not computed");
	});

	it("reports no native MCP tools without adapter assumptions", async () => {
		const resources = await invoke("resources mcp");
		const resourcesText = messageOf(lastNotify(resources.uiCalls));
		expect(resourcesText).toContain("no native MCP tools registered");
		expect(resourcesText).not.toMatch(/adapter/i);

		const status = await invoke("status");
		expect(messageOf(lastNotify(status.uiCalls))).toContain("no native MCP tools registered");
	});

	it("exposes argument completions", () => {
		expect(getDebugArgumentCompletions("tr")?.map((item) => item.value)).toEqual(["trace"]);
		expect(getDebugArgumentCompletions("--l")?.map((item) => item.value)).toEqual(["--limit"]);
		expect(getDebugArgumentCompletions("mcp t")?.map((item) => item.value)).toEqual(["mcp tools"]);
		expect(getDebugArgumentCompletions("zzz")).toBeNull();
	});
});

describe("context usage display", () => {
	async function runWith(
		command: string,
		contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
	): Promise<string> {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", hasUI: false, contextUsage });
		await fake.commands.get("debug")?.handler(command, ctx);
		return messageOf(lastNotify(uiCalls));
	}

	it("renders a 0–100 percent as 30.0%, not 3000%, with a ~30% bar", async () => {
		const text = await runWith("status", { tokens: 60000, contextWindow: 200000, percent: 30 });
		expect(text).toContain("60,000/200,000 tokens (30.0%)");
		expect(text).not.toContain("3000");
		const barLine = text.split("\n").find((line) => line.includes("█") || line.includes("░"));
		const filled = Array.from(barLine ?? "").filter((char) => char === "█").length;
		expect(filled).toBe(12);
	});

	it("renders the same percent units for stats context", async () => {
		const text = await runWith("stats context", { tokens: 60000, contextWindow: 200000, percent: 30 });
		expect(text).toContain("(30.0%)");
		expect(text).not.toContain("3000");
	});

	it("reports null percent as unavailable in status and stats", async () => {
		const status = await runWith("status", { tokens: null, contextWindow: 200000, percent: null });
		expect(status).toContain("unknown tokens/200,000 tokens (n/a)");
		expect(status).toContain("percent unavailable");

		const stats = await runWith("stats context", { tokens: null, contextWindow: 200000, percent: null });
		expect(stats).toContain("(n/a)");
		expect(stats).toContain("percent unavailable");
	});

	it("treats missing usage as unavailable in status", async () => {
		const status = await runWith("status", undefined);
		expect(status).toContain("unavailable (ctx.getContextUsage() returned undefined)");
	});

	it("does not warn at 79, informs at 80, warns at 90", async () => {
		const at79 = await runWith("doctor", { tokens: 158000, contextWindow: 200000, percent: 79 });
		expect(at79).toMatch(/ok\s+Context usage is 79\.0% of the window\./);
		expect(at79).not.toContain("compaction may be imminent");

		const at80 = await runWith("doctor", { tokens: 160000, contextWindow: 200000, percent: 80 });
		expect(at80).toMatch(/i\s+Context usage is 80\.0% of the window\./);
		expect(at80).not.toContain("compaction may be imminent");

		const at90 = await runWith("doctor", { tokens: 180000, contextWindow: 200000, percent: 90 });
		expect(at90).toMatch(/!\s+Context usage is 90\.0% of the window; a compaction may be imminent\./);
	});

	it("reports unknown context pressure when percent is null", async () => {
		const text = await runWith("doctor", { tokens: null, contextWindow: 200000, percent: null });
		expect(text).toContain("?   Context usage is unavailable");
	});

	it("keeps 0–1 metrics (tool error rate) on their own scale", async () => {
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		for (let index = 0; index < 4; index += 1) runtime.trace.metrics.noteToolEnd("read", 1, false);
		runtime.trace.metrics.noteToolEnd("read", 1, true);
		const { ctx, uiCalls } = createFakeContext({ mode: "print", hasUI: false });
		await fake.commands.get("debug")?.handler("stats tools", ctx);
		const text = messageOf(lastNotify(uiCalls));
		expect(text).toContain("errorRate=20.0%");
		expect(text).not.toContain("2000.0%");
	});
});

describe("export command", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-debug-tool-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a redacted jsonl export to an explicit path", async () => {
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		runtime.trace.setEnabled(true);
		runtime.trace.record("tool", "tool_execution_end", {
			toolCallId: "t1",
			durationMs: 12,
			data: { toolName: "read", authorization: "Bearer secret", resultBytes: 10 },
		});
		const { ctx, uiCalls } = createFakeContext({ mode: "print", cwd: dir });
		const target = join(dir, "out.jsonl");
		await fake.commands.get("debug")?.handler(`export jsonl ${target}`, ctx);

		expect(messageOf(lastNotify(uiCalls))).toContain("wrote jsonl export");
		const content = await readFile(target, "utf8");
		expect(content).not.toContain("Bearer secret");
		const records = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records[0]).toMatchObject({ tool: "pi-debug-tool", observerOnly: true });
		expect(records.some((record) => record.type === "trace")).toBe(true);
		expect(records.some((record) => record.type === "metrics")).toBe(true);
		expect(records.some((record) => record.type === "mcp")).toBe(true);
		expect(content).toContain("redacted");
	});

	it("writes a markdown export by default under cwd", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", cwd: dir });
		await fake.commands.get("debug")?.handler("export markdown", ctx);
		const report = messageOf(lastNotify(uiCalls));
		const match = report.match(/wrote markdown export: (.+)/);
		expect(match).toBeTruthy();
		const target = (match?.[1] ?? "").trim();
		expect(target.startsWith(join(dir, "debug-exports"))).toBe(true);
		const content = await readFile(target, "utf8");
		expect(content).toContain("# pi-debug-tool export");
	});

	it("refuses to overwrite an existing file without --force", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", cwd: dir });
		const target = join(dir, "again.jsonl");
		await fake.commands.get("debug")?.handler(`export jsonl ${target}`, ctx);
		await fake.commands.get("debug")?.handler(`export jsonl ${target}`, ctx);
		expect(messageOf(lastNotify(uiCalls))).toContain("--force");
		await fake.commands.get("debug")?.handler(`export jsonl ${target} --force`, ctx);
		expect(messageOf(lastNotify(uiCalls))).toContain("wrote jsonl export");
	});

	it("refuses a directory target", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", cwd: dir });
		const target = join(dir, "a-directory");
		await mkdir(target);
		await fake.commands.get("debug")?.handler(`export jsonl ${target}`, ctx);
		expect(messageOf(lastNotify(uiCalls))).toContain("path is a directory");
	});

	it("refuses a path outside cwd, home, and temp", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", cwd: dir });
		await fake.commands.get("debug")?.handler("export jsonl /etc/pi-debug-tool-should-not-exist.jsonl", ctx);
		expect(messageOf(lastNotify(uiCalls))).toContain("refused");
	});

	it("rejects an unknown export format", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", cwd: dir });
		await fake.commands.get("debug")?.handler("export yaml", ctx);
		expect(messageOf(lastNotify(uiCalls))).toContain("unknown format");
	});

	it("writes with mode 0600", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx } = createFakeContext({ mode: "print", cwd: dir });
		const target = join(dir, "perm.jsonl");
		await fake.commands.get("debug")?.handler(`export jsonl ${target}`, ctx);
		const info = await stat(target);
		expect(info.mode & 0o777).toBe(0o600);
	});
});

describe("native MCP command", () => {
	const tools = [
		makeMcpTool("github", "search", { exposure: "direct", annotations: { readOnlyHint: true } }),
		makeMcpTool("github", "delete", { exposure: "hidden" }),
		makeMcpTool("docs", "read", { exposure: "codemode" }),
	];
	const deps = (pi: FakePi["pi"]) => ({ pi, runtime: createRuntime({ clock: createFakeClock() }) });

	async function run(
		overrides: Parameters<typeof createFakePi>[0],
		command: string,
	): Promise<{ fake: FakePi; runtime: ReturnType<typeof createDebugExtension>; text: string }> {
		const fake = createFakePi(overrides);
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", hasUI: false });
		await fake.commands.get("debug")?.handler(command, ctx);
		return { fake, runtime, text: messageOf(lastNotify(uiCalls)) };
	}

	function fire(fake: FakePi, event: string, payload: Record<string, unknown>): void {
		for (const handler of fake.handlers.get(event) ?? []) handler({ type: event, ...payload }, createFakeContextEvent());
	}

	it("overview separates declared/callable and never claims connection", async () => {
		const { text } = await run({ allTools: tools, activeTools: ["mcp__github__search"] }, "mcp");
		expect(text).toContain("native MCP tools (getAllTools): 3 across 2 server(s)");
		expect(text).toContain("codemode/deferred tools are callable");
		expect(text).toContain("unavailable through public extension APIs");
		expect(text).toContain("connection status");
		expect(text).not.toMatch(/pi-mcp-adapter/);
		expect(text).not.toMatch(/\badapter\b/i);
	});

	it("tools table shows declared, callable, and hidden", async () => {
		const { text } = await run({ allTools: tools, activeTools: ["mcp__github__search"] }, "mcp tools");
		const rows = text.split("\n");
		const searchRow = rows.find((line) => line.includes("github") && line.includes("search")) ?? "";
		const deleteRow = rows.find((line) => line.includes("github") && line.includes("delete")) ?? "";
		const docsRow = rows.find((line) => line.startsWith("docs")) ?? "";
		expect(searchRow).toMatch(/direct\s+yes\s+yes\s+no/);
		expect(deleteRow).toMatch(/hidden\s+no\s+no\s+yes/);
		// codemode: not declared, still callable
		expect(docsRow).toMatch(/codemode\s+no\s+yes\s+no/);
	});

	it("filters tools by server", async () => {
		const { text } = await run({ allTools: tools, activeTools: [] }, "mcp tools github");
		expect(text).toContain("search");
		expect(text.split("\n").some((line) => line.startsWith("docs"))).toBe(false);
	});

	it("marks declared/callable unknown when getActiveTools fails", async () => {
		const { text } = await run({ allTools: tools, activeToolsError: "boom" }, "mcp tools");
		expect(text).toContain("partially unknown");
		const rows = text.split("\n");
		const searchRow = rows.find((line) => line.includes("github") && line.includes("search")) ?? "";
		expect(searchRow).toMatch(/direct\s+\?\s+\?/);
	});

	it("detects built-in vs third-party vs unknown /mcp providers", () => {
		const builtin = createFakePi({
			commandList: [makeCommand("mcp", { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" })],
		});
		expect(readMcpCommandProvider(deps(builtin.pi))).toEqual({ kind: "builtin", path: "builtin:mcp" });

		const syntheticPath = createFakePi({ commandList: [makeCommand("mcp", { path: "builtin:mcp", source: "local" })] });
		expect(readMcpCommandProvider(deps(syntheticPath.pi)).kind).toBe("builtin");

		const thirdParty = createFakePi({
			commandList: [makeCommand("mcp", { path: "/home/u/.pi/extensions/mcp-adapter.ts", source: "local" })],
		});
		expect(readMcpCommandProvider(deps(thirdParty.pi))).toMatchObject({ kind: "extension", source: "local" });

		const unknown = createFakePi({ commandList: [makeCommand("mcp", {})] });
		expect(readMcpCommandProvider(deps(unknown.pi))).toEqual({ kind: "unknown", path: null });

		const none = createFakePi({ commandList: [makeCommand("other", { path: "x", source: "local" })] });
		expect(readMcpCommandProvider(deps(none.pi)).kind).toBe("none");
	});

	it("does not warn on built-in /mcp and notes a third-party replacement", async () => {
		const builtin = await run(
			{ commandList: [makeCommand("mcp", { path: "builtin:mcp", source: "builtin" })] },
			"mcp doctor",
		);
		expect(builtin.text).toContain("built-in MCP integration");
		expect(builtin.text).not.toContain("provided by an extension");

		const third = await run(
			{ commandList: [makeCommand("mcp", { path: "/x/mcp.ts", source: "local" })] },
			"mcp doctor",
		);
		expect(third.text).toContain("replaced");

		const unknown = await run({ commandList: [makeCommand("mcp", {})] }, "mcp doctor");
		expect(unknown.text).toContain("could not be identified");
	});

	it("reports unknown declared/callable state from readInventory when getActiveTools throws", () => {
		const fake = createFakePi({ allTools: tools, activeToolsError: "nope" });
		const result = readInventory(deps(fake.pi));
		expect(result.value).not.toBeNull();
		expect(result.value?.activeKnown).toBe(false);
		expect(result.note).toContain("getActiveTools");
	});

	it("masks secrets and bounds API exception text in output", async () => {
		const { text } = await run(
			{ allToolsError: "getAllTools failed: Authorization: Bearer SUPER_SECRET_VALUE" },
			"mcp tools",
		);
		expect(text).toContain("unavailable");
		expect(text).not.toContain("SUPER_SECRET_VALUE");
		expect(text).toContain("<redacted>");
	});

	it("lists extension registrations without leaking their config", async () => {
		const { text } = await run(
			{
				mcpServers: [
					{
						name: "jira",
						extensionPath: "/ext/jira.ts",
						config: { url: "https://mcp.example.com", headers: { Authorization: "Bearer SUPER_SECRET" } },
					},
				],
			},
			"mcp",
		);
		expect(text).toContain("jira");
		expect(text).not.toContain("SUPER_SECRET");
		expect(text).not.toContain("Authorization");
		expect(text).not.toContain("mcp.example.com");
	});

	it("aggregates native calls and shows per-call detail when tracing is on", async () => {
		const { fake, runtime } = await (async () => {
			const local = createFakePi({ allTools: tools, activeTools: ["mcp__github__search"] });
			const rt = createDebugExtension(local.pi, { clock: createFakeClock() });
			rt.trace.setEnabled(true);
			return { fake: local, runtime: rt };
		})();
		expect(runtime.trace.isEnabled()).toBe(true);
		fire(fake, "tool_execution_start", { toolCallId: "t1", toolName: "mcp__github__search" });
		fire(fake, "tool_execution_start", { toolCallId: "p1/1", toolName: "mcp__docs__read", parentToolCallId: "p1" });
		fire(fake, "tool_execution_end", { toolCallId: "t1", toolName: "mcp__github__search", isError: false, parentToolCallId: null });
		fire(fake, "tool_execution_end", { toolCallId: "p1/1", toolName: "mcp__docs__read", isError: true, parentToolCallId: "p1" });

		const { ctx, uiCalls } = createFakeContext({ mode: "print" });
		await fake.commands.get("debug")?.handler("mcp calls", ctx);
		const text = messageOf(lastNotify(uiCalls));
		expect(text).toContain("calls=2");
		expect(text).toContain("nested=1");
		expect(text).toContain("toolCallId");
		expect(text).toContain("p1/1");
		expect(text).toContain("error");
	});

	it("keeps call counts but asks for tracing before per-call detail", async () => {
		const fake = createFakePi({ allTools: tools, activeTools: ["mcp__github__search"] });
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		fire(fake, "tool_execution_start", { toolCallId: "t1", toolName: "mcp__github__search" });
		fire(fake, "tool_execution_end", { toolCallId: "t1", toolName: "mcp__github__search", isError: false, parentToolCallId: null });
		const { ctx, uiCalls } = createFakeContext({ mode: "print" });
		await fake.commands.get("debug")?.handler("mcp calls", ctx);
		const text = messageOf(lastNotify(uiCalls));
		expect(text).toContain("calls=1");
		expect(text).toContain("needs /debug trace on");
	});

	it("reports non-MCP tool calls are not counted", async () => {
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		fire(fake, "tool_execution_start", { toolCallId: "t9", toolName: "read" });
		fire(fake, "tool_execution_end", { toolCallId: "t9", toolName: "read", isError: false });
		expect(runtime.mcpCalls.snapshot().calls).toBe(0);
	});

	it("treats an MCP end with no observed start as unpaired (duration unavailable)", async () => {
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		fire(fake, "tool_execution_end", { toolCallId: "ghost", toolName: "mcp__srv__tool", isError: false });
		const summary = runtime.mcpCalls.snapshot();
		expect(summary.unpaired).toBe(1);
		const tool = summary.byTool.find((entry) => entry.name === "mcp__srv__tool");
		expect(tool?.meanMs).toBeNull();
	});
});
