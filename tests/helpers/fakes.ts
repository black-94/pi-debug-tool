import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Test doubles.
 *
 * They implement only the surface the debug extension is allowed to touch and
 * record every method call so tests can assert that no context-polluting API
 * was used.
 */

export interface Call {
	method: string;
	args: unknown[];
}

export interface FakeClock {
	wallNow(): number;
	monoNow(): number;
	advance(ms: number): void;
}

export function createFakeClock(startWall = 1_700_000_000_000, startMono = 0): FakeClock {
	let mono = startMono;
	return {
		wallNow: () => startWall + mono,
		monoNow: () => mono,
		advance: (ms: number) => {
			mono += ms;
		},
	};
}

export interface FakeBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
	emitCount: number;
	handlers: Map<string, Array<(data: unknown) => void>>;
	unsubscribed: number;
}

export function createFakeBus(): FakeBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const bus: FakeBus = {
		emitCount: 0,
		handlers,
		unsubscribed: 0,
		emit(channel, data) {
			bus.emitCount += 1;
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				bus.unsubscribed += 1;
				const current = handlers.get(channel) ?? [];
				handlers.set(
					channel,
					current.filter((entry) => entry !== handler),
				);
			};
		},
	};
	return bus;
}

export interface RegisteredCommandLike {
	name: string;
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface FakePi {
	pi: ExtensionAPI;
	bus: FakeBus;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	commands: Map<string, RegisteredCommandLike>;
	calls: Call[];
	forbiddenCalls: Call[];
	allTools: unknown[];
	activeTools: string[];
	commandList: unknown[];
	mcpServers: unknown[];
}

/** Methods the extension must never call. */
export const FORBIDDEN_METHODS = [
	"registerTool",
	"setActiveTools",
	"sendMessage",
	"sendUserMessage",
	"appendEntry",
	"registerMessageRenderer",
	"registerEntryRenderer",
	"registerMarkdownTransformer",
	"registerProvider",
	"unregisterProvider",
	"registerShortcut",
	"registerFlag",
	"setSessionName",
	"setLabel",
	"exec",
	"setModel",
	"setThinkingLevel",
	"refreshTools",
	"registerMcpServer",
	"unregisterMcpServer",
	"registerVirtualModel",
	"unregisterVirtualModel",
] as const;

export interface FakePiOptions {
	allTools?: unknown[];
	activeTools?: string[];
	commandList?: unknown[];
	/** When set, `getActiveTools()` throws the given message. */
	activeToolsError?: string;
	/** When set, `getAllTools()` throws the given message. */
	allToolsError?: string;
	mcpServers?: unknown[];
}

export function createFakePi(options: FakePiOptions = {}): FakePi {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, RegisteredCommandLike>();
	const calls: Call[] = [];
	const forbiddenCalls: Call[] = [];
	const bus = createFakeBus();

	const record = (method: string, args: unknown[]): void => {
		const entry = { method, args };
		calls.push(entry);
		if ((FORBIDDEN_METHODS as readonly string[]).includes(method)) {
			forbiddenCalls.push(entry);
		}
	};

	const api: Record<string, unknown> = {
		events: bus,
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			record("on", [event, handler]);
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				handlers.set(
					event,
					(handlers.get(event) ?? []).filter((entry) => entry !== handler),
				);
			};
		},
		registerCommand(name: string, command: Omit<RegisteredCommandLike, "name">) {
			record("registerCommand", [name, command]);
			commands.set(name, { name, ...command });
		},
		getAllTools() {
			record("getAllTools", []);
			if (options.allToolsError) throw new Error(options.allToolsError);
			return options.allTools ?? [];
		},
		getActiveTools() {
			record("getActiveTools", []);
			if (options.activeToolsError) throw new Error(options.activeToolsError);
			return options.activeTools ?? [];
		},
		getCommands() {
			record("getCommands", []);
			return options.commandList ?? [];
		},
		getMcpServers() {
			record("getMcpServers", []);
			return options.mcpServers ?? [];
		},
	};

	// Every forbidden method gets a spy so accidental use is recorded (and the
	// tests fail loudly instead of silently succeeding).
	for (const method of FORBIDDEN_METHODS) {
		api[method] = (...args: unknown[]) => {
			record(method, args);
		};
	}

	return {
		pi: api as unknown as ExtensionAPI,
		bus,
		handlers,
		commands,
		calls,
		forbiddenCalls,
		allTools: options.allTools ?? [],
		activeTools: options.activeTools ?? [],
		commandList: options.commandList ?? [],
		mcpServers: options.mcpServers ?? [],
	};
}

export interface FakeToolInput {
	name: string;
	exposure?: string;
	namespaceName?: string;
	namespaceDescription?: string;
	description?: string;
	annotations?: Record<string, boolean>;
	source?: { path?: string; source?: string; scope?: string; origin?: string };
}

/** Build a `getAllTools()`-shaped record. */
export function makeTool(input: FakeToolInput): Record<string, unknown> {
	const tool: Record<string, unknown> = {
		name: input.name,
		description: input.description ?? "tool",
		parameters: {},
		promptGuidelines: [],
		exposure: input.exposure ?? "direct",
		sourceInfo: {
			path: input.source?.path ?? "builtin:read",
			source: input.source?.source ?? "builtin",
			scope: input.source?.scope ?? "temporary",
			origin: input.source?.origin ?? "top-level",
		},
	};
	if (input.namespaceName !== undefined) {
		tool.namespace = { name: input.namespaceName, description: input.namespaceDescription ?? "ns" };
	}
	if (input.annotations !== undefined) tool.annotations = input.annotations;
	return tool;
}

/**
 * Build an MCP tool as Pi's built-in MCP extension registers it: name
 * `mcp__<server>__<tool>` and namespace `mcp__<server>`.
 */
export function makeMcpTool(server: string, tool: string, options: Partial<FakeToolInput> = {}): Record<string, unknown> {
	return makeTool({
		name: `mcp__${server}__${tool}`,
		namespaceName: `mcp__${server}`,
		exposure: options.exposure ?? "codemode",
		annotations: options.annotations,
		source: options.source ?? { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
	});
}

/** Build a `getCommands()`-shaped record. */
export function makeCommand(name: string, sourceInfo: Record<string, unknown>, description = ""): Record<string, unknown> {
	return { name, source: "extension", description, sourceInfo };
}

export interface FakeSessionManagerOptions {
	entries?: unknown[];
	projection?: unknown;
	branch?: unknown[];
	tree?: unknown[];
	id?: string;
	file?: string | undefined;
	cwd?: string;
	name?: string | undefined;
	leafId?: string | null;
}

export interface FakeSessionManager {
	manager: ExtensionCommandContext["sessionManager"];
	calls: string[];
}

export const DEFAULT_ENTRIES: unknown[] = [
	{ type: "message", id: "e1", parentId: null, timestamp: "t1", message: { role: "user", content: "hello" } },
	{
		type: "message",
		id: "e2",
		parentId: "e1",
		timestamp: "t2",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: {
				input: 100,
				output: 20,
				cacheRead: 30,
				cacheWrite: 10,
				totalTokens: 160,
				cost: { total: 0.001 },
			},
		},
	},
	{
		type: "message",
		id: "e3",
		parentId: "e2",
		timestamp: "t3",
		message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false },
	},
	{
		type: "usage",
		id: "e4",
		parentId: "e3",
		timestamp: "t4",
		kind: "cache_warm",
		provider: "anthropic",
		model: "claude-x",
		usage: { input: 5, output: 1, cacheRead: 50, cacheWrite: 0, totalTokens: 56, cost: { total: 0.0002 } },
	},
];

export const DEFAULT_PROJECTION: unknown = {
	entries: [
		{
			sourceEntry: { id: "e1", type: "message" },
			messages: [{ role: "user", content: "hello world" }],
		},
		{
			sourceEntry: { id: "e2", type: "message" },
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "hi" },
						{ type: "toolCall", name: "read", arguments: { path: "/tmp/x", token: "secret-token" } },
					],
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
				},
			],
		},
	],
	messages: [],
	thinkingLevel: "medium",
	model: { provider: "anthropic", modelId: "claude-x" },
};

export function createFakeSessionManager(options: FakeSessionManagerOptions = {}): FakeSessionManager {
	const calls: string[] = [];
	const entries = options.entries ?? DEFAULT_ENTRIES;
	const projection = options.projection ?? DEFAULT_PROJECTION;
	const manager = {
		getSessionId: () => {
			calls.push("getSessionId");
			return options.id ?? "session-test";
		},
		getSessionFile: () => {
			calls.push("getSessionFile");
			return options.file;
		},
		getCwd: () => {
			calls.push("getCwd");
			return options.cwd ?? "/tmp/project";
		},
		getSessionDir: () => {
			calls.push("getSessionDir");
			return "/tmp/sessions";
		},
		getSessionName: () => {
			calls.push("getSessionName");
			return options.name;
		},
		getLeafId: () => {
			calls.push("getLeafId");
			return options.leafId ?? "e3";
		},
		getLeafEntry: () => {
			calls.push("getLeafEntry");
			return undefined;
		},
		getEntry: () => {
			calls.push("getEntry");
			return undefined;
		},
		getLabel: () => {
			calls.push("getLabel");
			return undefined;
		},
		getBranch: () => {
			calls.push("getBranch");
			return options.branch ?? entries;
		},
		buildContextEntries: () => {
			calls.push("buildContextEntries");
			return options.branch ?? entries;
		},
		buildSessionProjection: () => {
			calls.push("buildSessionProjection");
			return projection;
		},
		getHeader: () => {
			calls.push("getHeader");
			return { type: "session", id: options.id ?? "session-test", timestamp: "t0", cwd: options.cwd ?? "/tmp/project" };
		},
		getEntries: () => {
			calls.push("getEntries");
			return entries;
		},
		getTree: () => {
			calls.push("getTree");
			return options.tree ?? [{ entry: entries[0], children: [] }];
		},
	};
	return { manager: manager as unknown as ExtensionCommandContext["sessionManager"], calls };
}

export interface FakeTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export const fakeTheme: FakeTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

export interface FakeContextOptions extends FakeSessionManagerOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	cwd?: string;
	model?: { provider: string; id: string } | undefined;
	thinkingLevel?: string;
	idle?: boolean;
	trusted?: boolean;
	pending?: boolean;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	systemPrompt?: string;
	systemPromptOptions?: unknown;
	/** Override the `ui.custom` implementation (for overlay tests). */
	onCustom?: (factory: (...args: unknown[]) => unknown, options: unknown) => Promise<unknown>;
}

export interface FakeContext {
	ctx: ExtensionCommandContext;
	uiCalls: Call[];
}

export function createFakeContext(options: FakeContextOptions = {}): FakeContext {
	const session = createFakeSessionManager(options);
	const uiCalls: Call[] = [];
	const recordUi = (method: string, args: unknown[]): void => {
		uiCalls.push({ method, args });
	};

	const ui: Record<string, unknown> = {
		theme: fakeTheme,
		notify: (message: string, type?: string) => recordUi("notify", [message, type]),
		select: async (...args: unknown[]) => {
			recordUi("select", args);
			return undefined;
		},
		confirm: async (...args: unknown[]) => {
			recordUi("confirm", args);
			return false;
		},
		input: async (...args: unknown[]) => {
			recordUi("input", args);
			return undefined;
		},
		custom: async (factory: (...args: unknown[]) => unknown, customOptions: unknown) => {
			recordUi("custom", [customOptions]);
			if (options.onCustom) return options.onCustom(factory, customOptions);
			return undefined;
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	const ctx = {
		ui,
		mode: options.mode ?? "print",
		hasUI: options.hasUI ?? false,
		cwd: options.cwd ?? "/tmp/project",
		sessionManager: session.manager,
		modelRegistry: {},
		model: options.model ?? undefined,
		scopedModels: [],
		thinkingLevel: options.thinkingLevel,
		isIdle: () => options.idle ?? true,
		isProjectTrusted: () => options.trusted ?? true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => options.pending ?? false,
		shutdown: () => {},
		getContextUsage: () => options.contextUsage,
		compact: () => {},
		getSystemPrompt: () => options.systemPrompt ?? "SYSTEM PROMPT",
		getSystemPromptOptions: () =>
			options.systemPromptOptions ?? {
				cwd: options.cwd ?? "/tmp/project",
				selectedTools: ["read", "bash"],
				toolSnippets: { read: "Read a file" },
				toolGuidelines: { read: ["guideline a", "guideline b"] },
				promptGuidelines: ["be nice"],
				sections: { preamble: "preamble text", rules: "rules text" },
				contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "context" }],
				skills: [
					{
						name: "demo",
						description: "a demo skill",
						filePath: "/tmp/project/skills/demo/SKILL.md",
						sourceInfo: { path: "/tmp/project/skills", scope: "project", origin: "top-level", source: "skills" },
						disableModelInvocation: false,
					},
				],
			},
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	};

	return { ctx: ctx as unknown as ExtensionCommandContext, uiCalls };
}

export function createFakeContextEvent(): ExtensionContext {
	const { ctx } = createFakeContext();
	return ctx as unknown as ExtensionContext;
}
