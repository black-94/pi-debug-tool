import { describe, expect, it } from "vitest";
import {
	contextPercentToFraction,
	formatContextPercent,
	formatPercent,
	normalizeContextPercent,
	renderBar,
} from "../src/core/format";

describe("formatPercent (0–1 ratios)", () => {
	it("scales a 0–1 ratio by 100", () => {
		expect(formatPercent(0)).toBe("0.0%");
		expect(formatPercent(0.214)).toBe("21.4%");
		expect(formatPercent(1)).toBe("100.0%");
	});

	it("reports missing or non-finite ratios as n/a", () => {
		expect(formatPercent(null)).toBe("n/a");
		expect(formatPercent(undefined)).toBe("n/a");
		expect(formatPercent(Number.NaN)).toBe("n/a");
	});
});

describe("normalizeContextPercent (Pi 0–100 contract)", () => {
	it("keeps in-range percentage points unchanged", () => {
		expect(normalizeContextPercent(0)).toBe(0);
		expect(normalizeContextPercent(30)).toBe(30);
		expect(normalizeContextPercent(80)).toBe(80);
		expect(normalizeContextPercent(90)).toBe(90);
		expect(normalizeContextPercent(100)).toBe(100);
	});

	it("returns null for missing or non-finite values", () => {
		expect(normalizeContextPercent(null)).toBeNull();
		expect(normalizeContextPercent(undefined)).toBeNull();
		expect(normalizeContextPercent(Number.NaN)).toBeNull();
		expect(normalizeContextPercent(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("clamps out-of-range values into [0, 100]", () => {
		expect(normalizeContextPercent(-5)).toBe(0);
		expect(normalizeContextPercent(150)).toBe(100);
	});
});

describe("formatContextPercent", () => {
	it("treats numbers as percentage points, not ratios", () => {
		expect(formatContextPercent(0)).toBe("0.0%");
		expect(formatContextPercent(30)).toBe("30.0%");
		expect(formatContextPercent(90)).toBe("90.0%");
		expect(formatContextPercent(100)).toBe("100.0%");
	});

	it("never emits negative or above-100 percentages", () => {
		expect(formatContextPercent(-5)).toBe("0.0%");
		expect(formatContextPercent(150)).toBe("100.0%");
	});

	it("reports unknown values as n/a", () => {
		expect(formatContextPercent(null)).toBe("n/a");
		expect(formatContextPercent(undefined)).toBe("n/a");
		expect(formatContextPercent(Number.NaN)).toBe("n/a");
	});
});

describe("contextPercentToFraction + renderBar", () => {
	it("maps a 30% reading to a roughly 30% filled bar", () => {
		const fraction = contextPercentToFraction(30);
		expect(fraction).toBeCloseTo(0.3, 5);
		const bar = renderBar(fraction ?? 0, 40);
		const filled = Array.from(bar).filter((char) => char === "█").length;
		expect(filled).toBe(12);
		expect(Array.from(bar)).toHaveLength(40);
	});

	it("returns null for unknown percent so callers can report unavailable", () => {
		expect(contextPercentToFraction(null)).toBeNull();
		expect(contextPercentToFraction(undefined)).toBeNull();
		expect(contextPercentToFraction(Number.NaN)).toBeNull();
	});

	it("clamps out-of-range percent to a full/empty bar", () => {
		expect(renderBar(contextPercentToFraction(150) ?? 0, 10)).toBe("█".repeat(10));
		expect(renderBar(contextPercentToFraction(-5) ?? 0, 10)).toBe("░".repeat(10));
	});
});
