import type { Subcommand } from "./deps";

const SEPARATOR = "─".repeat(58);

export const runHelp: Subcommand = async () => ({
	title: "/debug help",
	lines: [
		"pi-debug-tool — observer-only debug commands",
		SEPARATOR,
		"/debug status                      session/cwd/mode/trust/idle/model/context/branch + summary",
		"/debug mcp [overview|tools|calls|doctor] [server] [--limit N]",
		"                                   native MCP inventory + call metadata (observer-only)",
		"/debug resources [tools|commands|skills|mcp]",
		"                                   public-API resource inventory",
		"/debug context [summary|sections|messages] [--detail] [--limit N]",
		"                                   read-only projection; metadata-only by default",
		"/debug trace on|off|status|tail [--limit N]",
		"                                   in-memory ring buffer of metadata events",
		"/debug timeline [--limit N]        run/turn/toolCall-correlated text timeline",
		"/debug stats [session|tools|cache|context|errors]",
		"                                   explicit-denominator statistics",
		"/debug doctor                      conservative, fact-based hints",
		"/debug export jsonl|markdown [path] [--force]",
		"                                   write a redacted export (only explicit file write)",
		"/debug clear                       clear this extension's trace/metrics only",
		"/debug help                        this help",
		SEPARATOR,
		"Safety: this extension is observer-only.",
		"  - registers no model-facing tools, skills, prompts, or messages",
		"  - never calls registerTool/setActiveTools/sendMessage/sendUserMessage/appendEntry",
		"  - never modifies context, system prompt, tool calls, or provider payloads",
		"  - never connects, calls, reconnects, or toggles an MCP server",
		"  - commands only render to the UI, except /debug export which writes a file",
		"The model never sees any of this data.",
	],
});
