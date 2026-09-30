import { describe, expect, it } from "vitest";
import { createDebugExtension } from "../src/extension";
import { createFakeClock, createFakeContext, createFakePi, fakeTheme } from "./helpers/fakes";

/** Every command that must be side-effect-free with respect to the session. */
const SAFE_COMMANDS = [
	"status",
	"mcp",
	"mcp overview",
	"mcp tools",
	"mcp tools github --limit 5",
	"mcp calls",
	"mcp calls --server github",
	"mcp doctor",
	"resources",
	"resources tools",
	"resources commands",
	"resources skills",
	"resources mcp",
	"context",
	"context summary",
	"context sections",
	"context messages",
	"context messages --detail --limit 5",
	"trace status",
	"trace on",
	"trace tail --limit 5",
	"trace off",
	"timeline",
	"stats",
	"stats session",
	"stats tools",
	"stats cache",
	"stats context",
	"stats errors",
	"doctor",
	"clear",
	"help",
	"not-a-real-subcommand",
];

function deepCopy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("zero context pollution", () => {
	it("keeps system prompt, active tools, and session projection identical across every command", async () => {
		const fake = createFakePi({ allTools: [], activeTools: ["read", "bash"] });
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const handler = fake.commands.get("debug")?.handler;
		expect(handler).toBeDefined();
		const { ctx } = createFakeContext({ mode: "print", hasUI: false });

		const before = {
			systemPrompt: ctx.getSystemPrompt(),
			systemPromptOptions: deepCopy(ctx.getSystemPromptOptions()),
			activeTools: [...fake.pi.getActiveTools()],
			projection: deepCopy(ctx.sessionManager.buildSessionProjection()),
			branch: deepCopy(ctx.sessionManager.getBranch()),
			entries: deepCopy(ctx.sessionManager.getEntries()),
		};

		for (const command of SAFE_COMMANDS) {
			await handler?.(command, ctx);
		}

		const after = {
			systemPrompt: ctx.getSystemPrompt(),
			systemPromptOptions: deepCopy(ctx.getSystemPromptOptions()),
			activeTools: [...fake.pi.getActiveTools()],
			projection: deepCopy(ctx.sessionManager.buildSessionProjection()),
			branch: deepCopy(ctx.sessionManager.getBranch()),
			entries: deepCopy(ctx.sessionManager.getEntries()),
		};

		expect(after).toEqual(before);
		expect(fake.forbiddenCalls).toEqual([]);
	});

	it("only renders to the UI in non-TUI modes", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx, uiCalls } = createFakeContext({ mode: "print", hasUI: false });
		await fake.commands.get("debug")?.handler("status", ctx);
		expect(uiCalls.every((call) => call.method === "notify")).toBe(true);
		expect(uiCalls.length).toBeGreaterThan(0);
	});

	it("uses a TUI overlay without a session effect", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		let overlayRendered: string[] = [];
		let overlayClosed = false;
		const { ctx, uiCalls } = createFakeContext({
			mode: "tui",
			hasUI: true,
			onCustom: async (factory) => {
				const component = factory(
					{ requestRender: () => {} },
					fakeTheme,
					{},
					() => {
						overlayClosed = true;
					},
				) as { render(width: number): string[]; handleInput?(data: string): void };
				overlayRendered = component.render(80);
				component.handleInput?.("j");
				component.handleInput?.("q");
				return undefined;
			},
		});

		await fake.commands.get("debug")?.handler("status", ctx);

		expect(uiCalls.some((call) => call.method === "custom")).toBe(true);
		expect(overlayRendered.length).toBeGreaterThan(0);
		expect(overlayClosed).toBe(true);
		expect(fake.forbiddenCalls).toEqual([]);
	});

	it("does not trigger an agent turn when a command runs", async () => {
		const fake = createFakePi();
		createDebugExtension(fake.pi, { clock: createFakeClock() });
		const { ctx } = createFakeContext({ mode: "print" });
		await fake.commands.get("debug")?.handler("help", ctx);
		const methods = fake.calls.map((call) => call.method);
		expect(methods).not.toContain("sendMessage");
		expect(methods).not.toContain("sendUserMessage");
	});
});
