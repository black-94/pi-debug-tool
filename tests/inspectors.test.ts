import { describe, expect, it } from "vitest";
import {
	listProjectedMessages,
	summarizeCommands,
	summarizeProjection,
	summarizeSkills,
	summarizeSystemPromptOptions,
	summarizeSystemPromptText,
	summarizeTools,
} from "../src/core/inspectors";
import { DEFAULT_PROJECTION } from "./helpers/fakes";

describe("summarizeTools", () => {
	const all = [
		{
			name: "read",
			description: "read a file",
			parameters: { type: "object" },
			promptGuidelines: ["a", "b"],
			sourceInfo: { path: "/p/ext/read.ts", scope: "project", origin: "top-level" },
		},
		{
			name: "pkg_tool",
			description: "from a package",
			sourceInfo: { path: "node_modules/pkg", scope: "user", origin: "package" },
		},
	];

	it("marks active tools and reports source metadata", () => {
		const summary = summarizeTools(all, ["read", "ghost"]);
		expect(summary.allCount).toBe(2);
		expect(summary.activeCount).toBe(1);
		expect(summary.activeUnknown).toEqual(["ghost"]);
		const read = summary.rows.find((row) => row.name === "read");
		expect(read?.active).toBe(true);
		expect(read?.guidelineCount).toBe(2);
		expect(read?.hasParameterSchema).toBe(true);
		expect(read?.sourceScope).toBe("project");
		const pkg = summary.rows.find((row) => row.name === "pkg_tool");
		expect(pkg?.sourceLabel).toBe("package: node_modules/pkg");
	});
});

describe("summarizeCommands", () => {
	it("groups by source and preserves paths", () => {
		const summary = summarizeCommands([
			{ name: "help", source: "extension", description: "help", sourceInfo: { path: "/a/help.ts" } },
			{ name: "review", source: "prompt", sourceInfo: { path: "/b/review.md" } },
			{ name: "deploy", source: "skill", sourceInfo: { path: "/c/skill.md" } },
		]);
		expect(summary.total).toBe(3);
		expect(summary.bySource).toEqual({ extension: 1, prompt: 1, skill: 1 });
		expect(summary.rows[0]?.path).toContain("/");
	});
});

describe("summarizeSkills", () => {
	it("reads skills from public systemPromptOptions", () => {
		const summary = summarizeSkills({
			skills: [
				{
					name: "review",
					description: "review code",
					filePath: "/s/review/SKILL.md",
					disableModelInvocation: true,
					sourceInfo: { scope: "user" },
				},
			],
		});
		expect(summary.available).toBe(true);
		expect(summary.total).toBe(1);
		expect(summary.skills[0]).toMatchObject({ name: "review", modelInvocable: false, sourceScope: "user" });
	});

	it("reports unavailable when skills are not exposed", () => {
		expect(summarizeSkills({}).available).toBe(true);
		expect(summarizeSkills(undefined).available).toBe(false);
	});
});

describe("summarizeProjection", () => {
	it("counts messages and blocks without exposing bodies", () => {
		const summary = summarizeProjection(DEFAULT_PROJECTION);
		expect(summary.projectedEntries).toBe(2);
		expect(summary.messages).toBe(2);
		expect(summary.messagesByRole).toEqual({ user: 1, assistant: 1 });
		expect(summary.contentBlocks.text).toBe(2);
		expect(summary.contentBlocks.toolCall).toBe(1);
		expect(summary.thinkingLevel).toBe("medium");
		expect(summary.model).toEqual({ provider: "anthropic", modelId: "claude-x" });
		expect(summary.approximateBytes).toBeGreaterThan(0);
	});

	it("tolerates an unexpected shape", () => {
		expect(summarizeProjection(null).messages).toBe(0);
		expect(summarizeProjection({ entries: "nope" }).projectedEntries).toBe(0);
	});
});

describe("listProjectedMessages", () => {
	it("omits bodies by default", () => {
		const messages = listProjectedMessages(DEFAULT_PROJECTION, {});
		expect(messages).toHaveLength(2);
		expect(messages.every((message) => message.preview === "")).toBe(true);
		expect(messages[1]?.blocks.some((block) => block.kind === "toolCall")).toBe(true);
	});

	it("previews with detail only, redacting sensitive tool-call arguments", () => {
		const messages = listProjectedMessages(DEFAULT_PROJECTION, { detail: true });
		expect(messages[0]?.preview).toBe("hello world");
		expect(messages[1]?.preview).toBe("hi");
	});

	it("honours the limit", () => {
		expect(listProjectedMessages(DEFAULT_PROJECTION, { limit: 1 })).toHaveLength(1);
	});
});

describe("summarizeSystemPromptOptions", () => {
	it("summarizes sections, guidelines, files, and overrides", () => {
		const summary = summarizeSystemPromptOptions({
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "snippet" },
			toolGuidelines: { read: ["g1", "g2"] },
			promptGuidelines: ["p1"],
			sections: { preamble: "abc", rules: "defg" },
			contextFiles: [{ path: "/p/AGENTS.md", content: "context" }],
			customPrompt: undefined,
			forceSystemPrompt: "forced",
			appendSystemPrompt: "appended",
		});
		expect(summary.available).toBe(true);
		expect(summary.selectedTools).toEqual(["read", "bash"]);
		expect(summary.toolSnippetCount).toBe(1);
		expect(summary.toolGuidelineTools).toBe(1);
		expect(summary.guidelineCount).toBe(3);
		expect(summary.sectionNames).toEqual(["preamble", "rules"]);
		expect(summary.sectionBytes.preamble).toBe(5); // JSON string includes quotes
		expect(summary.contextFiles).toEqual([{ path: "/p/AGENTS.md", bytes: 9 }]);
		expect(summary.hasForcedPrompt).toBe(true);
		expect(summary.hasCustomPrompt).toBe(false);
	});

	it("reports unavailable for a non-object", () => {
		expect(summarizeSystemPromptOptions(undefined).available).toBe(false);
	});
});

describe("summarizeSystemPromptText", () => {
	it("returns size only", () => {
		expect(summarizeSystemPromptText("hello")).toEqual({ available: true, bytes: 7 });
		expect(summarizeSystemPromptText(undefined)).toEqual({ available: false, bytes: 0 });
	});
});
