import { describe, expect, it } from "vitest";
import {
	byteSize,
	describeContentBlock,
	isSensitiveKey,
	redactErrorText,
	redactString,
	safeJson,
	sanitizeLabel,
	sanitizeValue,
} from "../src/core/redaction";

describe("isSensitiveKey", () => {
	it.each(["authorization", "Authorization", "x-api-key", "api_key", "Cookie", "set-cookie", "access_token", "secret", "password", "bearer", "private_key", "SESSION_KEY"])(
		"flags %s",
		(key) => {
			expect(isSensitiveKey(key)).toBe(true);
		},
	);

	it.each(["content", "path", "role", "model", "status"])("does not flag %s", (key) => {
		expect(isSensitiveKey(key)).toBe(false);
	});
});

describe("sanitizeValue", () => {
	it("redacts sensitive keys at any depth", () => {
		const result = sanitizeValue({
			headers: { Authorization: "Bearer abc", "x-api-key": "xyz", accept: "application/json" },
			nested: { password: "hunter2" },
		}) as Record<string, unknown>;
		const headers = result.headers as Record<string, unknown>;
		expect(headers.Authorization).toBe("<redacted>");
		expect(headers["x-api-key"]).toBe("<redacted>");
		expect(headers.accept).toBe("application/json");
		expect((result.nested as Record<string, unknown>).password).toBe("<redacted>");
	});

	it("truncates long strings and fully redacts base64 blobs", () => {
		const long = "a".repeat(300);
		expect(String(sanitizeValue(long))).toContain("<+100 chars>");
		const base64 = "A".repeat(600);
		expect(sanitizeValue(base64)).toBe("<redacted base64 length=600>");
	});

	it("bounds arrays and object keys", () => {
		const array = sanitizeValue(Array.from({ length: 60 }, (_, index) => index)) as unknown[];
		expect(array).toHaveLength(51);
		expect(array[50]).toBe("<+10 more items>");

		const wide: Record<string, number> = {};
		for (let i = 0; i < 60; i += 1) wide[`k${i}`] = i;
		const result = sanitizeValue(wide) as Record<string, unknown>;
		expect(result["<truncated>"]).toBe("<+10 more keys>");
	});

	it("bounds nesting depth", () => {
		let nested: unknown = "leaf";
		for (let i = 0; i < 10; i += 1) nested = { nested };
		const result = sanitizeValue(nested);
		expect(JSON.stringify(result)).toContain("max-depth");
	});

	it("converts unsupported values without throwing", () => {
		const result = sanitizeValue({ fn: () => 1, undef: undefined, big: 10n }) as Record<string, unknown>;
		expect(result.fn).toBe("<unsupported>");
		expect(result.big).toBe("10");
	});

	it("survives circular references through safeJson", () => {
		const circular: Record<string, unknown> = { name: "x" };
		circular.self = circular;
		expect(() => JSON.stringify(circular)).toThrow();
		expect(safeJson(circular)).toBeTruthy();
	});
});

describe("redactString", () => {
	it("keeps short strings and truncates long ones", () => {
		expect(redactString("hello", 10)).toBe("hello");
		expect(redactString("hello world", 5)).toBe("hello…<+6 chars>");
	});
});

describe("describeContentBlock", () => {
	it("reports text size and only previews when asked", () => {
		const hidden = describeContentBlock({ type: "text", text: "hello" }, false);
		expect(hidden.kind).toBe("text");
		expect(hidden.preview).toBe("");
		const shown = describeContentBlock({ type: "text", text: "hello" }, true);
		expect(shown.preview).toBe("hello");
	});

	it("never exposes image bytes", () => {
		const shape = describeContentBlock({ type: "image", data: "A".repeat(1000), mimeType: "image/png" }, true);
		expect(shape.kind).toBe("image");
		expect(shape.bytes).toBe(1000);
		expect(shape.preview).toBe("<image image/png bytes=1000>");
		expect(shape.preview).not.toContain("AAAA");
	});

	it("labels thinking and tool calls without content", () => {
		expect(describeContentBlock({ type: "thinking", thinking: "secret reasoning" }, true).preview).toBe("<thinking>");
		const call = describeContentBlock({ type: "toolCall", name: "read", arguments: { path: "/x" } }, true);
		expect(call.kind).toBe("toolCall");
		expect(call.preview).toBe("<toolCall read>");
	});
});

describe("byteSize", () => {
	it("measures JSON-faithful sizes safely", () => {
		expect(byteSize("abc")).toBe(5); // JSON string includes quotes
		expect(byteSize({ a: 1 })).toBe(Buffer.byteLength('{"a":1}', "utf8"));
	});
});

describe("sanitizeLabel", () => {
	it("neutralizes control characters so metadata cannot inject lines or escapes", () => {
		expect(sanitizeLabel("gh\nub\u001b[31m")).toBe("gh?ub?[31m");
	});

	it("bounds length and rejects non-strings", () => {
		const long = "s".repeat(300);
		expect(sanitizeLabel(long, 40)).toContain("<+260 chars>");
		expect(sanitizeLabel(undefined)).toBe("");
		expect(sanitizeLabel(42)).toBe("");
	});
});

describe("redactErrorText", () => {
	it("masks bearer tokens and key=value secrets", () => {
		const masked = redactErrorText("request failed: Authorization: Bearer SUPER_SECRET_VALUE");
		expect(masked).not.toContain("SUPER_SECRET_VALUE");
		expect(masked).toContain("<redacted>");

		const kv = redactErrorText("connect ECONNREFUSED token=abc123def456");
		expect(kv).not.toContain("abc123def456");
	});

	it("bounds and never throws on odd inputs", () => {
		expect(redactErrorText("x".repeat(500)).length).toBeLessThan(300);
		expect(redactErrorText(new Error("boom"))).toBe("boom");
		expect(() => redactErrorText({ toString: () => { throw new Error("nope"); } })).not.toThrow();
	});
});
