import { formatDurationMs, formatWallTime, truncate } from "../core/format";
import { safeJson } from "../core/redaction";
import type { TraceEvent } from "../core/types";

export function shortId(id: string): string {
	return id.length <= 8 ? id : id.slice(0, 8);
}

/** Compact `key=value` rendering of already-sanitized metadata. */
export function formatData(data: Record<string, unknown> | undefined, max = 140): string {
	if (!data) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;
		let text: string;
		if (typeof value === "number") text = String(value);
		else if (typeof value === "boolean") text = String(value);
		else text = truncate(typeof value === "string" ? value : safeJson(value), 40);
		parts.push(`${key}=${text}`);
	}
	return truncate(parts.join(" "), max);
}

/** One-line rendering of a trace event with explicit correlation ids. */
export function formatEventLine(event: TraceEvent, baseMono?: number): string {
	const time = formatWallTime(event.wallTime);
	const relative = baseMono === undefined ? "" : `+${Math.max(0, event.monoTime - baseMono).toFixed(0)}ms`;
	const ids: string[] = [];
	if (event.runId !== undefined) ids.push(`run=${event.runId}`);
	if (event.turnIndex !== undefined) ids.push(`turn=${event.turnIndex}`);
	if (event.requestId !== undefined) ids.push(`req=${event.requestId}`);
	if (event.messageSeq !== undefined) ids.push(`msg=${event.messageSeq}`);
	if (event.toolCallId) ids.push(`tool=${shortId(event.toolCallId)}`);
	const duration = event.durationMs !== undefined ? ` ${formatDurationMs(event.durationMs)}` : "";
	const data = formatData(event.data);
	return [
		time,
		relative.padStart(9),
		event.kind.padEnd(9),
		event.name,
		duration,
		ids.length > 0 ? `  ${ids.join(" ")}` : "",
		data ? `  ${data}` : "",
	].join("");
}
