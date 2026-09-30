import { computeSessionMetrics } from "../core/session-metrics";
import { contextPercentToFraction, formatContextPercent, formatPercent, formatCount } from "../core/format";
import { readInventory, readMcpCommandProvider, readRegisteredServers } from "./mcp";
import { safe, type Subcommand } from "./deps";

const SEPARATOR = "─".repeat(58);

interface Finding {
	level: "ok" | "warn" | "info" | "unknown";
	text: string;
}

/**
 * Doctor: conservative, fact-based hints.
 *
 * It only reports things the extension actually observed through public APIs.
 * Anything Pi does not expose is listed under "not available" instead of being
 * inferred or fetched through private means.
 */
export const runDoctor: Subcommand = async (_args, ctx, deps) => {
	const findings: Finding[] = [];
	const trace = deps.runtime.trace;
	const metrics = trace.snapshotMetrics();

	// Tracing posture.
	if (trace.isEnabled()) {
		findings.push({ level: "ok", text: "Tracing is on; ring entries and tool durations are being captured." });
	} else {
		findings.push({
			level: "info",
			text: "Tracing is off. /debug status and /debug stats work without it, but /debug timeline and /debug trace tail need /debug trace on.",
		});
	}
	if (trace.ring.dropped > 0) {
		findings.push({
			level: "warn",
			text: `Ring buffer dropped ${formatCount(trace.ring.dropped)} event(s) (capacity ${formatCount(trace.ring.capacity)}). Increase capture by exporting sooner or relying on /debug stats counters.`,
		});
	}

	// MCP posture. Evidence only: native tool metadata and observed calls.
	// Connection state and mcp.json config are not exposed to extensions, so
	// they are reported as unavailable instead of guessed.
	const inventory = readInventory(deps);
	const mcpCalls = deps.runtime.mcpCalls.snapshot();
	if (!inventory.value) {
		findings.push({ level: "unknown", text: `MCP tool inventory is unavailable (${inventory.error}).` });
	} else if (inventory.value.total === 0) {
		findings.push({
			level: "info",
			text: "No native MCP tools are registered via the public API. Not a verdict: no server may be configured, servers may still be connecting, or MCP may be replaced/disabled. Verify with /mcp or `pi mcp list`.",
		});
	} else {
		findings.push({
			level: "ok",
			text: `Native MCP tools observed: ${formatCount(inventory.value.total)} across ${inventory.value.servers.length} server(s); declared=${inventory.value.declaredCount} callable=${inventory.value.callableCount} hidden=${inventory.value.hiddenCount}.`,
		});
	}
	if (inventory.value && inventory.value.hiddenCount > 0) {
		findings.push({
			level: "info",
			text: `${formatCount(inventory.value.hiddenCount)} MCP tool(s) are registered but hidden (unreachable); see /debug mcp tools.`,
		});
	}
	if (inventory.value && inventory.value.unknownExposureCount > 0) {
		findings.push({
			level: "info",
			text: `${formatCount(inventory.value.unknownExposureCount)} MCP tool(s) reported no recognized exposure; callable state is not asserted.`,
		});
	}
	if (inventory.value && inventory.value.malformedNames.length > 0) {
		findings.push({
			level: "warn",
			text: `MCP-prefixed names that do not match mcp__<server>__<tool>: ${inventory.value.malformedNames.slice(0, 5).join(", ")} (server not guessed).`,
		});
	}
	if (mcpCalls.calls > 0) {
		if (mcpCalls.errors > 0) {
			findings.push({
				level: mcpCalls.ended > 0 && mcpCalls.errors / mcpCalls.ended >= 0.2 ? "warn" : "info",
				text: `Observed ${formatCount(mcpCalls.errors)} native MCP call error(s) of ${formatCount(mcpCalls.ended)} completed (rate ${formatPercent(mcpCalls.errorRate)}).`,
			});
		} else {
			findings.push({
				level: "ok",
				text: `Observed ${formatCount(mcpCalls.ended)} native MCP call(s), no errors; nested=${formatCount(mcpCalls.nested)} maxConcurrent=${mcpCalls.maxConcurrent}.`,
			});
		}
	}
	const registered = readRegisteredServers(deps);
	if (!registered.value) {
		findings.push({ level: "info", text: `Extension MCP registrations unavailable (${registered.error}).` });
	} else if (registered.value.length > 0) {
		findings.push({
			level: "info",
			text: `${registered.value.length} MCP server(s) are registered by extensions (session-only; not connection state).`,
		});
	}
	const provider = readMcpCommandProvider(deps);
	if (provider.kind === "extension") {
		findings.push({
			level: "info",
			text: `/mcp is provided by an extension (${provider.path}); built-in MCP support is replaced while it is loaded.`,
		});
	} else if (provider.kind === "builtin") {
		findings.push({ level: "ok", text: "/mcp is provided by Pi's built-in MCP integration." });
	} else if (provider.kind === "unknown") {
		findings.push({
			level: "info",
			text: "An extension /mcp command was observed, but its source could not be identified from public metadata.",
		});
	}
	findings.push({
		level: "unknown",
		text: "MCP connection state, mcp.json config, transports, credentials, and resources are not exposed to extensions; that is expected. Use /mcp or `pi mcp list`.",
	});

	// Runtime posture.
	const idle = safe(() => ctx.isIdle());
	if (idle.ok && idle.value === false) {
		findings.push({ level: "info", text: "The agent is currently streaming; some counts are still in flight." });
	}
	const pending = safe(() => ctx.hasPendingMessages());
	if (pending.ok && pending.value === true) {
		findings.push({ level: "info", text: "There are queued messages waiting to be delivered." });
	}

	// Context pressure. Pi's ContextUsage.percent is 0–100; normalize to a
	// fraction so the thresholds below are expressed in 0–1 terms.
	const usage = safe(() => ctx.getContextUsage());
	const usageValue = usage.ok ? usage.value : undefined;
	const contextFraction = usageValue ? contextPercentToFraction(usageValue.percent) : null;
	if (usageValue && contextFraction !== null) {
		const percent = formatContextPercent(usageValue.percent);
		if (contextFraction >= 0.9) {
			findings.push({ level: "warn", text: `Context usage is ${percent} of the window; a compaction may be imminent.` });
		} else if (contextFraction >= 0.8) {
			findings.push({ level: "info", text: `Context usage is ${percent} of the window.` });
		} else {
			findings.push({ level: "ok", text: `Context usage is ${percent} of the window.` });
		}
	} else {
		findings.push({ level: "unknown", text: "Context usage is unavailable (tokens may be unknown right after compaction)." });
	}

	// Error posture.
	if (metrics.tools.completed >= 5 && metrics.tools.errorRate !== null && metrics.tools.errorRate >= 0.2) {
		findings.push({
			level: "warn",
			text: `Tool error rate is ${formatPercent(metrics.tools.errorRate)} over ${formatCount(metrics.tools.completed)} completed calls.`,
		});
	}
	const entries = safe(() => ctx.sessionManager.getEntries());
	if (entries.ok) {
		const session = computeSessionMetrics(entries.value as readonly unknown[]);
		if (session.toolResults.errorRate !== null && session.toolResults.errorRate >= 0.2 && session.toolResults.total >= 5) {
			findings.push({
				level: "warn",
				text: `Session toolResult error rate is ${formatPercent(session.toolResults.errorRate)} over ${formatCount(session.toolResults.total)} results.`,
			});
		}
	}
	if (metrics.internalErrors > 0) {
		findings.push({
			level: "warn",
			text: `The debug extension swallowed ${formatCount(metrics.internalErrors)} internal error(s); Pi was unaffected.`,
		});
	}

	const lines: string[] = ["pi-debug-tool — doctor", SEPARATOR];
	for (const finding of findings) {
		const marker = finding.level === "ok" ? "ok  " : finding.level === "warn" ? "!   " : finding.level === "info" ? "i   " : "?   ";
		lines.push(`${marker}${finding.text}`);
	}

	lines.push(SEPARATOR);
	lines.push("Deliberately not available (Pi exposes no public API for these):");
	lines.push("  - per-extension handler timings or results");
	lines.push("  - the complete extension registry");
	lines.push("  - retry/queue internal scheduling details");
	lines.push("  - cache hit counts (only cache read/write token counts are public)");
	lines.push("  - full provider payloads, thinking text, or image bytes");
	lines.push("  - MCP connection state, mcp.json config, transports, credentials, resources (use /mcp or `pi mcp list`)");
	return { title: "/debug doctor", lines };
};
