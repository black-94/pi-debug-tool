import {
	summarizeCommands,
	summarizeSkills,
	summarizeTools,
} from "../core/inspectors";
import { renderTable } from "../core/format";
import { mcpResourceLines } from "./mcp";
import { safe, type CommandDeps, type Subcommand } from "./deps";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const SEPARATOR = "─".repeat(58);

export const runResources: Subcommand = async (args, ctx, deps) => {
	const topic = (args.positionals[0] ?? "all").toLowerCase();
	const lines: string[] = [`pi-debug-tool — resources (${topic})`, SEPARATOR];

	switch (topic) {
		case "tools":
			lines.push(...toolsLines(deps));
			break;
		case "commands":
			lines.push(...commandsLines(deps));
			break;
		case "skills":
			lines.push(...skillsLines(ctx));
			break;
		case "mcp":
			lines.push(...mcpLines(deps));
			break;
		case "all":
			lines.push("## tools", ...toolsLines(deps), "");
			lines.push("## commands", ...commandsLines(deps), "");
			lines.push("## skills", ...skillsLines(ctx), "");
			lines.push("## mcp", ...mcpLines(deps));
			break;
		default:
			lines.push(`unknown resource "${topic}". Use: tools | commands | skills | mcp`);
	}

	lines.push(SEPARATOR);
	lines.push("Source: public Pi APIs only (getAllTools/getActiveTools/getCommands/getMcpServers/systemPromptOptions).");
	return { title: `/debug resources ${topic}`, lines };
};

export function toolsLines(deps: CommandDeps): string[] {
	const all = safe(() => deps.pi.getAllTools());
	const active = safe(() => deps.pi.getActiveTools());
	if (!all.ok) return [`unavailable (${all.error})`];
	const activeNames = active.ok ? active.value : [];
	const summary = summarizeTools(all.value as readonly unknown[], activeNames);
	const lines: string[] = [
		`active=${summary.activeCount}  all=${summary.allCount}  (all = every registered tool; active = currently exposed to the model)`,
	];
	const rows = summary.rows.map((row) => [
		row.active ? "active" : "-",
		row.name,
		`${row.guidelineCount}g`,
		row.sourceScope,
		row.sourceLabel,
	]);
	lines.push(...renderTable(["state", "tool", "guide", "scope", "source"], rows));
	if (summary.activeUnknown.length > 0) {
		lines.push(`! active names with no matching registered tool: ${summary.activeUnknown.join(", ")}`);
	}
	return lines;
}

export function commandsLines(deps: CommandDeps): string[] {
	const commands = safe(() => deps.pi.getCommands());
	if (!commands.ok) return [`unavailable (${commands.error})`];
	const summary = summarizeCommands(commands.value as readonly unknown[]);
	const bySource = Object.entries(summary.bySource)
		.map(([source, count]) => `${source}=${count}`)
		.join("  ");
	const lines = [`total=${summary.total}  ${bySource || "none"}`];
	const rows = summary.rows.map((row) => [row.source, `/${row.name}`, row.description, row.path]);
	lines.push(...renderTable(["source", "command", "description", "path"], rows));
	return lines;
}

export function skillsLines(ctx: ExtensionCommandContext): string[] {
	const options = safe(() => ctx.getSystemPromptOptions());
	if (!options.ok) return [`unavailable (${options.error})`];
	const summary = summarizeSkills(options.value);
	if (!summary.available) return ["unavailable (systemPromptOptions not exposed in this context)"];
	if (summary.total === 0) return ["no skills in the current system prompt options"];
	const rows = summary.skills.map((skill) => [
		skill.name,
		skill.modelInvocable ? "model" : "explicit",
		skill.sourceScope,
		skill.filePath,
	]);
	const lines = [`total=${summary.total} (from public systemPromptOptions.skills)`];
	lines.push(...renderTable(["skill", "invocation", "scope", "path"], rows));
	return lines;
}

export function mcpLines(deps: CommandDeps): string[] {
	return mcpResourceLines(deps);
}
