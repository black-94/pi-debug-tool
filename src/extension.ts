import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDebugHandler, getDebugArgumentCompletions } from "./commands";
import { registerObservers } from "./observers";
import { createRuntime, type DebugRuntime, type DebugRuntimeOptions } from "./runtime";

/**
 * Build the observer-only debug extension.
 *
 * Registration surface (the complete list):
 * - `pi.on(...)` observer handlers that always return `undefined`
 * - `pi.registerCommand("debug")` — the only capability exposed to the user
 *
 * Nothing here registers a tool, message renderer, provider, shortcut, flag,
 * skill, or prompt template; nothing subscribes to `mcp_servers_change` (which
 * would mark this extension as the MCP connector); and nothing writes to the
 * session or context.
 *
 * Returns the runtime so tests can inspect it; the Pi factory discards it.
 */
export function createDebugExtension(pi: ExtensionAPI, options: DebugRuntimeOptions = {}): DebugRuntime {
	const runtime = createRuntime(options);
	registerObservers(pi, runtime);
	pi.registerCommand("debug", {
		description: "Observer-only debugging: status, resources, mcp, context, trace, timeline, stats, doctor, export",
		getArgumentCompletions: getDebugArgumentCompletions,
		handler: createDebugHandler(pi, runtime),
	});
	return runtime;
}

export default function piDebugTool(pi: ExtensionAPI): void {
	createDebugExtension(pi);
}
