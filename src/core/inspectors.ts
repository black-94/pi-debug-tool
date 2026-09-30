import { byteSize, describeContentBlock, type ContentShape } from "./redaction";

/**
 * Read-only projections of Pi's public state into presentation-friendly shapes.
 *
 * Everything here takes `unknown` and narrows structurally, so the extension
 * never depends on private module paths and cannot be broken by unrelated
 * internal type changes. No function mutates its input.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Session projection / context
// ---------------------------------------------------------------------------

export interface ContextSummary {
	projectedEntries: number;
	messages: number;
	messagesByRole: Record<string, number>;
	contentBlocks: { text: number; image: number; thinking: number; toolCall: number; other: number };
	approximateBytes: number;
	thinkingLevel: string | null;
	model: { provider: string; modelId: string } | null;
}

/** Summarize `sessionManager.buildSessionProjection()` without exposing bodies. */
export function summarizeProjection(projection: unknown): ContextSummary {
	const messagesByRole: Record<string, number> = {};
	const contentBlocks = { text: 0, image: 0, thinking: 0, toolCall: 0, other: 0 };
	let approximateBytes = 0;
	let messages = 0;

	const root = isRecord(projection) ? projection : {};
	const entries = asArray(root.entries);
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		for (const message of asArray(entry.messages)) {
			messages += 1;
			const role = (isRecord(message) && asString(message.role)) || "unknown";
			messagesByRole[role] = (messagesByRole[role] ?? 0) + 1;
			const content = isRecord(message) ? message.content : undefined;
			if (typeof content === "string") {
				contentBlocks.text += 1;
				approximateBytes += byteSize(content);
				continue;
			}
			for (const block of asArray(content)) {
				const shape = describeContentBlock(block, false);
				approximateBytes += shape.bytes;
				contentBlocks[shape.kind === "other" ? "other" : shape.kind] += 1;
			}
		}
	}

	const modelRecord = isRecord(root.model) ? root.model : undefined;
	const provider = modelRecord ? asString(modelRecord.provider) : undefined;
	const modelId = modelRecord ? asString(modelRecord.modelId) : undefined;

	return {
		projectedEntries: entries.length,
		messages,
		messagesByRole,
		contentBlocks,
		approximateBytes,
		thinkingLevel: asString(root.thinkingLevel) ?? null,
		model: provider && modelId ? { provider, modelId } : null,
	};
}

export interface ProjectedMessageInfo {
	index: number;
	role: string;
	sourceEntryId: string;
	sourceEntryType: string;
	bytes: number;
	blocks: ContentShape[];
	/** Truncated, redacted preview; empty unless `detail` was requested. */
	preview: string;
}

/**
 * List projected messages as metadata. Content bodies are omitted unless
 * `detail` is explicitly requested, and even then they are truncated/redacted.
 */
export function listProjectedMessages(
	projection: unknown,
	options: { limit?: number; detail?: boolean; maxPreview?: number; maxEntries?: number } = {},
): ProjectedMessageInfo[] {
	const limit = options.limit ?? 50;
	const detail = options.detail ?? false;
	const maxPreview = options.maxPreview ?? 120;
	const maxEntries = options.maxEntries ?? 500;
	const root = isRecord(projection) ? projection : {};
	const out: ProjectedMessageInfo[] = [];
	let index = 0;
	for (const entry of asArray(root.entries)) {
		if (out.length >= maxEntries) break;
		if (!isRecord(entry)) continue;
		const sourceEntry = isRecord(entry.sourceEntry) ? entry.sourceEntry : {};
		for (const message of asArray(entry.messages)) {
			if (out.length >= maxEntries) break;
			const rec = isRecord(message) ? message : {};
			const role = asString(rec.role) ?? "unknown";
			const rawContent = rec.content;
			const blocks: ContentShape[] = [];
			let bytes = 0;
			let preview = "";
			if (typeof rawContent === "string") {
				bytes = byteSize(rawContent);
				blocks.push(describeContentBlock({ type: "text", text: rawContent }, detail, maxPreview));
				preview = detail ? (describeContentBlock({ type: "text", text: rawContent }, true, maxPreview).preview ?? "") : "";
			} else {
				for (const block of asArray(rawContent)) {
					const shape = describeContentBlock(block, detail, maxPreview);
					blocks.push(shape);
					bytes += shape.bytes;
					if (!preview && detail && shape.preview) preview = shape.preview;
				}
			}
			out.push({
				index,
				role,
				sourceEntryId: asString(sourceEntry.id) ?? "?",
				sourceEntryType: asString(sourceEntry.type) ?? "?",
				bytes,
				blocks,
				preview,
			});
			index += 1;
		}
	}
	return out.slice(0, limit);
}

export interface PromptOptionsSummary {
	available: boolean;
	selectedTools: string[];
	toolSnippetCount: number;
	toolGuidelineTools: number;
	guidelineCount: number;
	sectionNames: string[];
	sectionBytes: Record<string, number>;
	contextFiles: Array<{ path: string; bytes: number }>;
	appendSystemPromptBytes: number;
	hasCustomPrompt: boolean;
	hasForcedPrompt: boolean;
}

/** Summarize `ctx.getSystemPromptOptions()` (base options; may be unnormalized). */
export function summarizeSystemPromptOptions(options: unknown): PromptOptionsSummary {
	if (!isRecord(options)) {
		return {
			available: false,
			selectedTools: [],
			toolSnippetCount: 0,
			toolGuidelineTools: 0,
			guidelineCount: 0,
			sectionNames: [],
			sectionBytes: {},
			contextFiles: [],
			appendSystemPromptBytes: 0,
			hasCustomPrompt: false,
			hasForcedPrompt: false,
		};
	}
	const toolSnippets = isRecord(options.toolSnippets) ? options.toolSnippets : {};
	const toolGuidelines = isRecord(options.toolGuidelines) ? options.toolGuidelines : {};
	const sections = isRecord(options.sections) ? options.sections : {};
	const sectionBytes: Record<string, number> = {};
	for (const [name, value] of Object.entries(sections)) {
		sectionBytes[name] = typeof value === "string" ? byteSize(value) : 0;
	}
	const guidelineCount =
		asArray(options.promptGuidelines).length +
		Object.values(toolGuidelines).reduce<number>((total, value) => total + asArray(value).length, 0);
	const contextFiles = asArray(options.contextFiles)
		.filter(isRecord)
		.map((file) => ({ path: asString(file.path) ?? "?", bytes: byteSize(file.content) }));

	return {
		available: true,
		selectedTools: asArray(options.selectedTools).filter((tool): tool is string => typeof tool === "string"),
		toolSnippetCount: Object.keys(toolSnippets).length,
		toolGuidelineTools: Object.keys(toolGuidelines).length,
		guidelineCount,
		sectionNames: Object.keys(sections),
		sectionBytes,
		contextFiles,
		appendSystemPromptBytes: typeof options.appendSystemPrompt === "string" ? byteSize(options.appendSystemPrompt) : 0,
		hasCustomPrompt: typeof options.customPrompt === "string" && options.customPrompt.length > 0,
		hasForcedPrompt: typeof options.forceSystemPrompt === "string" && options.forceSystemPrompt.length > 0,
	};
}

/** Size-only summary of the rendered system prompt. Content is never retained. */
export function summarizeSystemPromptText(text: string | undefined): { available: boolean; bytes: number } {
	if (typeof text !== "string") return { available: false, bytes: 0 };
	return { available: true, bytes: byteSize(text) };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface ToolResourceRow {
	name: string;
	active: boolean;
	descriptionBytes: number;
	hasParameterSchema: boolean;
	guidelineCount: number;
	sourcePath: string;
	sourceScope: string;
	sourceOrigin: string;
	sourceLabel: string;
}

export interface ToolResourceSummary {
	allCount: number;
	activeCount: number;
	activeUnknown: string[];
	rows: ToolResourceRow[];
}

/** Summarize `pi.getAllTools()` + `pi.getActiveTools()` with source metadata. */
export function summarizeTools(all: readonly unknown[], activeNames: readonly string[]): ToolResourceSummary {
	const activeSet = new Set(activeNames);
	const rows: ToolResourceRow[] = [];
	const known = new Set<string>();
	for (const tool of all) {
		if (!isRecord(tool)) continue;
		const name = asString(tool.name) ?? "?";
		known.add(name);
		const sourceInfo = isRecord(tool.sourceInfo) ? tool.sourceInfo : {};
		rows.push({
			name,
			active: activeSet.has(name),
			descriptionBytes: byteSize(asString(tool.description) ?? ""),
			hasParameterSchema: tool.parameters !== undefined,
			guidelineCount: asArray(tool.promptGuidelines).length,
			sourcePath: asString(sourceInfo.path) ?? "?",
			sourceScope: asString(sourceInfo.scope) ?? "?",
			sourceOrigin: asString(sourceInfo.origin) ?? "?",
			sourceLabel: summarizeSourceLabel(sourceInfo),
		});
	}
	rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
	return {
		allCount: rows.length,
		activeCount: rows.filter((row) => row.active).length,
		activeUnknown: activeNames.filter((name) => !known.has(name)),
		rows,
	};
}

export interface CommandResourceRow {
	name: string;
	source: string;
	description: string;
	path: string;
}

export interface CommandResourceSummary {
	total: number;
	bySource: Record<string, number>;
	rows: CommandResourceRow[];
}

/** Summarize `pi.getCommands()`. */
export function summarizeCommands(commands: readonly unknown[]): CommandResourceSummary {
	const rows: CommandResourceRow[] = [];
	const bySource: Record<string, number> = {};
	for (const command of commands) {
		if (!isRecord(command)) continue;
		const source = asString(command.source) ?? "unknown";
		bySource[source] = (bySource[source] ?? 0) + 1;
		const sourceInfo = isRecord(command.sourceInfo) ? command.sourceInfo : {};
		rows.push({
			name: asString(command.name) ?? "?",
			source,
			description: asString(command.description) ?? "",
			path: asString(sourceInfo.path) ?? "?",
		});
	}
	rows.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
	return { total: rows.length, bySource, rows };
}

export interface SkillResourceRow {
	name: string;
	description: string;
	filePath: string;
	modelInvocable: boolean;
	sourceScope: string;
}

export interface SkillResourceSummary {
	available: boolean;
	total: number;
	skills: SkillResourceRow[];
}

/** Summarize skills from the public `systemPromptOptions.skills` field. */
export function summarizeSkills(options: unknown): SkillResourceSummary {
	const skills = isRecord(options) ? asArray(options.skills) : [];
	if (!isRecord(options) || !Array.isArray(options.skills)) {
		return { available: options === undefined ? false : true, total: 0, skills: [] };
	}
	const rows: SkillResourceRow[] = [];
	for (const skill of skills) {
		if (!isRecord(skill)) continue;
		const sourceInfo = isRecord(skill.sourceInfo) ? skill.sourceInfo : {};
		rows.push({
			name: asString(skill.name) ?? "?",
			description: asString(skill.description) ?? "",
			filePath: asString(skill.filePath) ?? "?",
			modelInvocable: skill.disableModelInvocation !== true,
			sourceScope: asString(sourceInfo.scope) ?? "?",
		});
	}
	rows.sort((a, b) => a.name.localeCompare(b.name));
	return { available: true, total: rows.length, skills: rows };
}

function summarizeSourceLabel(sourceInfo: Record<string, unknown>): string {
	const path = asString(sourceInfo.path);
	const scope = asString(sourceInfo.scope);
	const origin = asString(sourceInfo.origin);
	if (origin === "package") {
		return path ? `package: ${path}` : "package";
	}
	return [scope, path].filter(Boolean).join(" ") || "unknown";
}
