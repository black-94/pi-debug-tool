import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncate } from "../core/format";

/** A renderable command result. Lines are plain text; no ANSI required. */
export interface DebugReport {
	title: string;
	lines: string[];
}

const OVERLAY_VIEWPORT = 22;
const NOTIFY_MAX_LINES = 40;
const NOTIFY_MAX_LINE_LENGTH = 400;

class TextOverlay {
	private offset = 0;

	constructor(
		private readonly report: DebugReport,
		private readonly theme: Theme,
		private readonly done: (value: undefined) => void,
	) {}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width);
		const body = this.report.lines;
		const viewport = Math.max(4, Math.min(OVERLAY_VIEWPORT, Math.max(body.length, 1)));
		this.offset = clamp(this.offset, 0, Math.max(0, body.length - viewport));

		const visible = body.slice(this.offset, this.offset + viewport);
		const out: string[] = [];
		out.push(this.theme.bold(this.theme.fg("accent", truncate(this.report.title, innerWidth))));
		out.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
		if (visible.length === 0) {
			out.push(this.theme.fg("dim", "(no data)"));
		} else {
			for (const line of visible) {
				out.push(truncate(line, innerWidth));
			}
		}
		out.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
		const from = body.length === 0 ? 0 : this.offset + 1;
		const to = Math.min(body.length, this.offset + viewport);
		const position = `${from}-${to} of ${body.length}`;
		const hint = truncate(`[q/esc] close  [↑/↓] scroll  ${position}`, innerWidth);
		out.push(this.theme.fg("dim", hint));
		return out;
	}

	handleInput(data: string): void {
		switch (data) {
			case "q":
			case "Q":
			case "\u001b":
			case "\r":
			case "\n":
				this.done(undefined);
				return;
			case "\u001b[A":
			case "k":
				this.offset -= 1;
				return;
			case "\u001b[B":
			case "j":
				this.offset += 1;
				return;
			case "\u001b[5~":
			case "u":
				this.offset -= OVERLAY_VIEWPORT;
				return;
			case "\u001b[6~":
			case "d":
				this.offset += OVERLAY_VIEWPORT;
				return;
			case "g":
				this.offset = 0;
				return;
			case "G":
				this.offset = Number.MAX_SAFE_INTEGER;
				return;
			default:
				return;
		}
	}

	invalidate(): void {
		// No cached render state.
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function formatCompactLines(report: DebugReport): string {
	const lines = report.lines.slice(0, NOTIFY_MAX_LINES).map((line) => truncate(line, NOTIFY_MAX_LINE_LENGTH));
	if (report.lines.length > NOTIFY_MAX_LINES) {
		lines.push(`…(+${report.lines.length - NOTIFY_MAX_LINES} more lines; /debug export for full output)`);
	}
	return [report.title, ...lines].join("\n");
}

export type PresentationMode = "overlay" | "notify" | "unavailable";

/**
 * Present a report to the user.
 *
 * - TUI: a scrollable overlay.
 * - Other UI modes (RPC): a notification.
 * - Headless modes: a best-effort notification; never throws, never writes to
 *   the model's context.
 */
export async function presentReport(ctx: ExtensionCommandContext, report: DebugReport): Promise<PresentationMode> {
	if (ctx.mode === "tui" && ctx.hasUI) {
		try {
			await ctx.ui.custom<undefined>(
				(_tui, theme, _keybindings, done) => new TextOverlay(report, theme, done),
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						maxHeight: "85%",
						anchor: "center",
					},
				},
			);
			return "overlay";
		} catch {
			// Fall through to notify so a rendering failure cannot break the command.
		}
	}
	try {
		ctx.ui.notify(formatCompactLines(report), "info");
		return "notify";
	} catch {
		return "unavailable";
	}
}

/** Present a short one-line status/error message. */
export function notifyLine(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Never let a UI failure surface as a command error.
	}
}
