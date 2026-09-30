/** Small, dependency-free formatting helpers for command output. */

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "n/a";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatCount(value: number): string {
	return Number.isFinite(value) ? value.toLocaleString("en-US") : "n/a";
}

export function formatDurationMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "n/a";
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
	if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds - minutes * 60;
	return `${minutes}m${rest.toFixed(0)}s`;
}

/**
 * Format a 0–1 ratio (e.g. tool error rate, cache share) as a percentage.
 * Pi's `ContextUsage.percent` is a different unit — use `formatContextPercent`.
 */
export function formatPercent(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
	return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Normalize Pi's public `ContextUsage.percent`, which is already a 0–100
 * percentage of the context window (e.g. 30 means 30%), unlike the internal
 * 0–1 ratios above. This is the single place where the unit is decoded.
 *
 * null / undefined / non-finite values yield null (callers report them as
 * unavailable/unknown). Finite values are clamped to [0, 100] so output can
 * never be nonsense such as 3000% or a bar past full.
 */
export function normalizeContextPercent(percent: number | null | undefined): number | null {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
	return Math.max(0, Math.min(100, percent));
}

/** Format Pi's 0–100 `ContextUsage.percent` for display (null → "n/a"). */
export function formatContextPercent(percent: number | null | undefined, digits = 1): string {
	const normalized = normalizeContextPercent(percent);
	return normalized === null ? "n/a" : `${normalized.toFixed(digits)}%`;
}

/** Convert Pi's 0–100 `ContextUsage.percent` to a renderBar fraction (0–1). */
export function contextPercentToFraction(percent: number | null | undefined): number | null {
	const normalized = normalizeContextPercent(percent);
	return normalized === null ? null : normalized / 100;
}

export function formatCost(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "n/a";
	if (value === 0) return "$0";
	return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

export function formatWallTime(ms: number): string {
	const date = new Date(ms);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	const milli = String(date.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${milli}`;
}

export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	if (max <= 1) return text.slice(0, max);
	return `${text.slice(0, max - 1)}…`;
}

/** Render a two-column table with simple space padding. */
export function renderTable(headers: string[], rows: string[][]): string[] {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const format = (cells: string[]): string =>
		cells
			.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0))
			.join("  ")
			.trimEnd();
	return [format(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(format)];
}

/**
 * A simple horizontal bar. Takes a 0–1 fraction, not a 0–100 percent: convert
 * Pi's `ContextUsage.percent` with `contextPercentToFraction` first.
 */
export function renderBar(fraction: number, width = 20): string {
	if (!Number.isFinite(fraction)) return "─".repeat(width);
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}
