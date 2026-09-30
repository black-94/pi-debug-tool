import {
	listProjectedMessages,
	summarizeProjection,
	summarizeSystemPromptOptions,
	summarizeSystemPromptText,
} from "../core/inspectors";
import { formatBytes, formatCount, renderTable } from "../core/format";
import { flagBool, flagNumber, type ParsedArgs } from "./args";
import { safe, type Subcommand } from "./deps";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const SEPARATOR = "─".repeat(58);

export const runContext: Subcommand = async (args, ctx, _deps) => {
	const topic = (args.positionals[0] ?? "summary").toLowerCase();
	const lines: string[] = [`pi-debug-tool — context (${topic})`, SEPARATOR];

	switch (topic) {
		case "summary":
			lines.push(...summaryLines(ctx));
			break;
		case "sections":
			lines.push(...sectionLines(ctx));
			break;
		case "messages":
			lines.push(...messageLines(ctx, args));
			break;
		default:
			lines.push(`unknown subcommand "${topic}". Use: summary | sections | messages`);
	}

	lines.push(SEPARATOR);
	lines.push("Read-only projection. Bodies are omitted unless --detail is given, and are then truncated/redacted.");
	return { title: `/debug context ${topic}`, lines };
};

function summaryLines(ctx: ExtensionCommandContext): string[] {
	const lines: string[] = [];
	const projection = safe(() => ctx.sessionManager.buildSessionProjection());
	if (!projection.ok) {
		lines.push(`projection: unavailable (${projection.error})`);
	} else {
		const summary = summarizeProjection(projection.value as unknown);
		lines.push(`projectedEntries: ${formatCount(summary.projectedEntries)}`);
		lines.push(`messages:         ${formatCount(summary.messages)}  ${formatRoleCounts(summary.messagesByRole)}`);
		lines.push(
			`contentBlocks:    text=${summary.contentBlocks.text} image=${summary.contentBlocks.image} ` +
				`thinking=${summary.contentBlocks.thinking} toolCall=${summary.contentBlocks.toolCall} other=${summary.contentBlocks.other}`,
		);
		lines.push(`approx. bytes:    ${formatBytes(summary.approximateBytes)}`);
		lines.push(`thinkingLevel:    ${summary.thinkingLevel ?? "unavailable"}`);
		lines.push(`projectionModel:  ${summary.model ? `${summary.model.provider}/${summary.model.modelId}` : "unavailable"}`);
	}

	const options = safe(() => ctx.getSystemPromptOptions());
	if (!options.ok) {
		lines.push(`systemPromptOptions: unavailable (${options.error})`);
	} else {
		const promptSummary = summarizeSystemPromptOptions(options.value);
		lines.push(
			`systemPromptOptions: sections=${promptSummary.sectionNames.length} selectedTools=${promptSummary.selectedTools.length} ` +
				`toolSnippets=${promptSummary.toolSnippetCount} guidelineTools=${promptSummary.toolGuidelineTools} ` +
				`guidelines=${promptSummary.guidelineCount} contextFiles=${promptSummary.contextFiles.length}`,
		);
		lines.push(
			`prompt overrides:   custom=${promptSummary.hasCustomPrompt} forced=${promptSummary.hasForcedPrompt} ` +
				`customPromptBytes=${formatBytes(promptSummary.appendSystemPromptBytes)}`,
		);
	}

	const promptText = safe(() => ctx.getSystemPrompt());
	const promptSize = summarizeSystemPromptText(promptText.ok ? promptText.value : undefined);
	lines.push(`rendered prompt:    ${promptSize.available ? formatBytes(promptSize.bytes) : "unavailable"} (size only; content not read into the report)`);
	return lines;
}

function sectionLines(ctx: ExtensionCommandContext): string[] {
	const options = safe(() => ctx.getSystemPromptOptions());
	if (!options.ok) return [`unavailable (${options.error})`];
	const summary = summarizeSystemPromptOptions(options.value);
	if (summary.sectionNames.length === 0) {
		return ["No named system-prompt sections in the current options."];
	}
	const rows = summary.sectionNames.map((name) => [name, formatBytes(summary.sectionBytes[name] ?? 0)]);
	return renderTable(["section", "bytes"], rows);
}

function messageLines(ctx: ExtensionCommandContext, args: ParsedArgs): string[] {
	const projection = safe(() => ctx.sessionManager.buildSessionProjection());
	if (!projection.ok) return [`unavailable (${projection.error})`];
	const detail = flagBool(args.flags, "detail");
	const limit = flagNumber(args.flags, "limit", 50);
	const messages = listProjectedMessages(projection.value as unknown, { limit, detail });
	const lines: string[] = [
		`showing ${messages.length} message(s); detail=${detail ? "on (truncated/redacted previews)" : "off (metadata only)"}`,
	];
	const rows = messages.map((message) => [
		String(message.index),
		message.role,
		message.sourceEntryType,
		formatBytes(message.bytes),
		`text=${countKind(message.blocks, "text")} img=${countKind(message.blocks, "image")} ` +
			`think=${countKind(message.blocks, "thinking")} call=${countKind(message.blocks, "toolCall")}`,
	]);
	lines.push(...renderTable(["#", "role", "entry", "bytes", "blocks"], rows));
	if (detail) {
		for (const message of messages) {
			if (message.preview) lines.push(`  #${message.index} ${message.role}: ${message.preview}`);
		}
	}
	return lines;
}

function countKind(blocks: Array<{ kind: string }>, kind: string): number {
	return blocks.filter((block) => block.kind === kind).length;
}

function formatRoleCounts(byRole: Record<string, number>): string {
	const entries = Object.entries(byRole);
	if (entries.length === 0) return "(none)";
	return entries.map(([role, count]) => `${role}=${count}`).join(" ");
}
