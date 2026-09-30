import { describe, expect, it } from "vitest";
import {
	McpCallStats,
	parseMcpToolName,
	resolveMcpToolIdentity,
	summarizeMcpTools,
} from "../src/core/mcp-native";
import { makeMcpTool, makeTool } from "./helpers/fakes";

describe("parseMcpToolName", () => {
	it("parses the documented mcp__<server>__<tool> shape", () => {
		expect(parseMcpToolName("mcp__github__search_code")).toEqual({
			server: "github",
			tool: "search_code",
			ambiguous: false,
		});
	});

	it("returns undefined for non-MCP names", () => {
		expect(parseMcpToolName("read")).toBeUndefined();
		expect(parseMcpToolName("mcp")).toBeUndefined();
		expect(parseMcpToolName(undefined)).toBeUndefined();
		expect(parseMcpToolName(42)).toBeUndefined();
	});

	it("marks a missing separator or empty tool as ambiguous, never a wrong server", () => {
		expect(parseMcpToolName("mcp__onlyone")).toEqual({ server: null, tool: null, ambiguous: true });
		expect(parseMcpToolName("mcp__srv__")).toEqual({ server: null, tool: null, ambiguous: true });
	});

	it("marks a server containing '__' as ambiguous rather than guessing", () => {
		// `mcp__my__server__tool` could be server "my" or "my__server".
		expect(parseMcpToolName("mcp__my__server__tool")).toEqual({ server: null, tool: null, ambiguous: true });
	});

	it("rejects invalid server characters", () => {
		expect(parseMcpToolName("mcp__bad server__tool")).toEqual({ server: null, tool: null, ambiguous: true });
	});
});

describe("resolveMcpToolIdentity", () => {
	it("uses the namespace as the exact server, even with '__' in the name", () => {
		const identity = resolveMcpToolIdentity("mcp__my__server__tool", "mcp__my__server");
		expect(identity?.server).toBe("my__server");
		expect(identity?.tool).toBe("tool");
		expect(identity?.serverSource).toBe("namespace");
	});

	it("falls back to an unambiguous name when there is no namespace", () => {
		const identity = resolveMcpToolIdentity("mcp__github__search_code", undefined);
		expect(identity?.server).toBe("github");
		expect(identity?.tool).toBe("search_code");
		expect(identity?.serverSource).toBe("name");
	});

	it("reports an ambiguous name without a namespace as unknown server", () => {
		const identity = resolveMcpToolIdentity("mcp__my__server__tool", undefined);
		expect(identity?.server).toBeNull();
		expect(identity?.ambiguous).toBe(true);
		expect(identity?.serverSource).toBe("unknown");
	});

	it("reports a namespace/name conflict instead of picking one", () => {
		const identity = resolveMcpToolIdentity("mcp__other__tool", "mcp__github");
		expect(identity?.server).toBeNull();
		expect(identity?.conflict).toBe(true);
		expect(identity?.serverSource).toBe("conflict");
	});

	it("returns undefined for non-MCP input", () => {
		expect(resolveMcpToolIdentity("read", undefined)).toBeUndefined();
		expect(resolveMcpToolIdentity("read", "other")).toBeUndefined();
	});
});

describe("summarizeMcpTools", () => {
	const all = [
		makeMcpTool("github", "search", { exposure: "direct" }),
		makeMcpTool("github", "list_repos", { exposure: "codemode" }),
		makeMcpTool("docs", "read_page", { exposure: "deferred" }),
		makeMcpTool("docs", "delete_page", { exposure: "hidden" }),
		makeMcpTool("docs", "ask", { exposure: "model-only" }),
		makeTool({ name: "read", exposure: "direct" }),
	];

	it("includes only MCP tools and ignores regular tools", () => {
		const summary = summarizeMcpTools(all, ["mcp__github__search"]);
		expect(summary.total).toBe(5);
		expect(summary.tools.some((tool) => tool.name === "read")).toBe(false);
	});

	it("distinguishes declared, callable, and hidden by exposure", () => {
		const summary = summarizeMcpTools(all, ["mcp__github__search", "mcp__docs__ask"]);
		const byName = new Map(summary.tools.map((tool) => [tool.name, tool]));
		// direct + active
		expect(byName.get("mcp__github__search")?.declared).toBe(true);
		expect(byName.get("mcp__github__search")?.callable).toBe(true);
		// codemode: not declared, still callable
		expect(byName.get("mcp__github__list_repos")?.declared).toBe(false);
		expect(byName.get("mcp__github__list_repos")?.callable).toBe(true);
		// deferred: not declared, callable
		expect(byName.get("mcp__docs__read_page")?.callable).toBe(true);
		// hidden: registered but unreachable
		expect(byName.get("mcp__docs__delete_page")?.hidden).toBe(true);
		expect(byName.get("mcp__docs__delete_page")?.callable).toBe(false);
		expect(byName.get("mcp__docs__delete_page")?.reachable).toBe(false);
		// model-only: declared but never callable
		expect(byName.get("mcp__docs__ask")?.declared).toBe(true);
		expect(byName.get("mcp__docs__ask")?.callable).toBe(false);
	});

	it("does not treat codemode/deferred tools as unavailable", () => {
		const summary = summarizeMcpTools(all, []);
		const codemode = summary.tools.find((tool) => tool.name === "mcp__github__list_repos");
		expect(codemode?.callable).toBe(true);
		expect(codemode?.reachable).toBe(true);
	});

	it("marks declared/callable unknown when getActiveTools is unavailable", () => {
		const summary = summarizeMcpTools(all, null);
		expect(summary.activeKnown).toBe(false);
		const direct = summary.tools.find((tool) => tool.name === "mcp__github__search");
		expect(direct?.declared).toBeNull();
		expect(direct?.callable).toBeNull();
		// codemode callability does not depend on the active set
		expect(summary.tools.find((tool) => tool.name === "mcp__github__list_repos")?.callable).toBe(true);
	});

	it("groups by server and counts states", () => {
		const summary = summarizeMcpTools(all, ["mcp__github__search", "mcp__docs__ask"]);
		expect(summary.servers.map((group) => group.server)).toEqual(["docs", "github"]);
		expect(summary.declaredCount).toBe(2);
		expect(summary.hiddenCount).toBe(1);
		expect(summary.byExposure).toMatchObject({ direct: 1, codemode: 1, deferred: 1, hidden: 1, "model-only": 1 });
	});

	it("marks unknown exposure without asserting callable", () => {
		const summary = summarizeMcpTools([makeMcpTool("s", "t", { exposure: "weird" })], []);
		expect(summary.tools[0]?.exposure).toBe("unknown");
		expect(summary.tools[0]?.callable).toBeNull();
		expect(summary.unknownExposureCount).toBe(1);
	});

	it("resolves a server whose name contains '__' via the namespace", () => {
		const summary = summarizeMcpTools([makeMcpTool("my__server", "do")], []);
		expect(summary.tools[0]?.server).toBe("my__server");
		expect(summary.tools[0]?.tool).toBe("do");
		expect(summary.ambiguousCount).toBe(0);
	});

	it("flags an MCP-prefixed but malformed name without guessing the server", () => {
		const summary = summarizeMcpTools([makeTool({ name: "mcp__broken" })], []);
		expect(summary.total).toBe(1);
		expect(summary.tools[0]?.server).toBeNull();
		expect(summary.malformedNames).toContain("mcp__broken");
		expect(summary.ambiguousCount).toBe(1);
	});

	it("neutralizes control characters in metadata labels", () => {
		const summary = summarizeMcpTools([makeMcpTool("gh\nub", "t")], []);
		expect(summary.tools[0]?.server).not.toContain("\n");
	});

	it("never throws on malformed tool records", () => {
		const summary = summarizeMcpTools([null, 42, {}, { name: "mcp__a__b", exposure: 7, namespace: "x" }], []);
		expect(summary.total).toBe(1);
		expect(summary.tools[0]?.exposure).toBe("unknown");
	});
});

describe("McpCallStats", () => {
	function begin(stats: McpCallStats, id: string, name: string, parent: string | undefined, wall: number): void {
		stats.begin(id, name, parent, wall);
	}
	function end(stats: McpCallStats, id: string, name: string, isError: boolean, duration: number | undefined, wall: number): void {
		stats.end(id, name, isError, duration, wall);
	}

	it("aggregates parallel calls with correct concurrency and durations", () => {
		const stats = new McpCallStats();
		begin(stats, "t1", "mcp__srv__a", undefined, 1);
		begin(stats, "t2", "mcp__srv__b", undefined, 2);
		end(stats, "t1", "mcp__srv__a", false, 150, 3);
		end(stats, "t2", "mcp__srv__b", true, 70, 4);
		const summary = stats.snapshot();
		expect(summary.calls).toBe(2);
		expect(summary.ended).toBe(2);
		expect(summary.errors).toBe(1);
		expect(summary.maxConcurrent).toBe(2);
		const a = summary.byTool.find((tool) => tool.name === "mcp__srv__a");
		expect(a?.server).toBe("srv");
		expect(a?.tool).toBe("a");
		expect(a?.meanMs).toBe(150);
	});

	it("correlates codemode/nested calls through parentToolCallId", () => {
		const stats = new McpCallStats();
		begin(stats, "p1/1", "mcp__srv__a", "p1", 1);
		begin(stats, "p1/2", "mcp__srv__b", "p1", 1);
		end(stats, "p1/1", "mcp__srv__a", false, 10, 2);
		end(stats, "p1/2", "mcp__srv__b", false, 10, 2);
		const summary = stats.snapshot();
		expect(summary.nested).toBe(2);
		expect(summary.distinctParents).toBe(1);
	});

	it("ignores duplicate ends so counts are not inflated", () => {
		const stats = new McpCallStats();
		begin(stats, "t1", "mcp__srv__a", undefined, 1);
		end(stats, "t1", "mcp__srv__a", false, 10, 2);
		end(stats, "t1", "mcp__srv__a", false, 10, 3);
		const summary = stats.snapshot();
		expect(summary.ended).toBe(1);
		expect(summary.duplicateEnds).toBe(1);
	});

	it("reports unpaired completion duration as unavailable, not zero", () => {
		const stats = new McpCallStats();
		end(stats, "ghost", "mcp__srv__a", true, undefined, 5);
		const summary = stats.snapshot();
		expect(summary.ended).toBe(1);
		expect(summary.errors).toBe(1);
		expect(summary.unpaired).toBe(1);
		const tool = summary.byTool.find((entry) => entry.name === "mcp__srv__a");
		expect(tool?.meanMs).toBeNull();
		expect(tool?.p95Ms).toBeNull();
	});

	it("keeps counts regardless of tracing and resets cleanly", () => {
		const stats = new McpCallStats();
		begin(stats, "t1", "mcp__srv__a", undefined, 1);
		end(stats, "t1", "mcp__srv__a", false, 5, 2);
		expect(stats.snapshot().calls).toBe(1);
		stats.reset();
		expect(stats.snapshot()).toMatchObject({ calls: 0, ended: 0, errors: 0, byTool: [] });
	});

	it("bounds the active map and reports dropped starts", () => {
		const stats = new McpCallStats();
		for (let index = 0; index < 600; index += 1) begin(stats, `t${index}`, "mcp__srv__a", undefined, index);
		const summary = stats.snapshot();
		expect(summary.droppedStarts).toBeGreaterThan(0);
		expect(summary.maxConcurrent).toBeLessThanOrEqual(512);
	});
});
