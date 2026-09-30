/**
 * Redaction and bounding helpers.
 *
 * The debug extension deliberately keeps only sizes and shapes of sensitive
 * payloads (tool arguments/results, prompts, provider payloads). These helpers
 * enforce that policy so no code path can accidentally retain secrets, full
 * base64 images, or unbounded strings.
 */

const SENSITIVE_KEY = /(authorization|auth|cookie|set-cookie|api[-_]?key|apikey|secret|password|passwd|token|bearer|credential|private[-_]?key|session[-_]?key)/i;

const BASE64_LIKE = /^[A-Za-z0-9+/=\r\n]{512,}$/;

export const DEFAULT_MAX_STRING = 200;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_ITEMS = 50;

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key);
}

/** Human-readable byte size of an arbitrary value. Never throws. */
export function byteSize(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return 0;
	}
}

function looksLikeBase64(value: string): boolean {
	return BASE64_LIKE.test(value);
}

/**
 * Redact one string: secrets-like content is replaced entirely, long content is
 * truncated with an explicit length marker.
 */
export function redactString(value: string, maxLength = DEFAULT_MAX_STRING): string {
	if (looksLikeBase64(value)) {
		return `<redacted base64 length=${value.length}>`;
	}
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength)}…<+${value.length - maxLength} chars>`;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const INLINE_AUTH = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const KV_SECRET =
	/((?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|credential|client[-_]?secret)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Sanitize a short metadata label (server/tool/path/id) for display.
 * Control characters are neutralized (a malicious server name cannot inject
 * newlines or terminal escapes) and the result is bounded.
 */
export function sanitizeLabel(value: unknown, maxLength = 120): string {
	if (typeof value !== "string") return "";
	return redactString(value.replace(CONTROL_CHARS, "?"), maxLength);
}

/**
 * Sanitize an API/command exception for display.
 *
 * Exception text can embed file paths, URLs, or even credentials, so it is
 * bounded, has control characters removed, and masks common secret shapes
 * (`Bearer <token>`, `token=...`). Never throws.
 */
export function redactErrorText(value: unknown, maxLength = 160): string {
	let text: string;
	try {
		if (typeof value === "string") text = value;
		else if (value instanceof Error) text = value.message;
		else text = String(value);
	} catch {
		return "<unreadable error>";
	}
	text = text.replace(CONTROL_CHARS, "?").replace(INLINE_AUTH, "$1 <redacted>").replace(KV_SECRET, "$1<redacted>");
	return redactString(text, maxLength);
}

export interface SanitizeOptions {
	maxString?: number;
	maxDepth?: number;
	maxItems?: number;
}

/**
 * Deep, bounded, secret-aware copy of a value.
 *
 * - Keys matching {@link isSensitiveKey} are replaced with `"<redacted>"`.
 * - Strings are truncated (or fully redacted when base64-like).
 * - Arrays/objects are bounded by `maxItems`/`maxDepth`.
 * - Functions, symbols, and undefined become `"<unsupported>"`.
 */
export function sanitizeValue(value: unknown, options: SanitizeOptions = {}): unknown {
	const maxString = options.maxString ?? DEFAULT_MAX_STRING;
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
	return walk(value, 0, maxString, maxDepth, maxItems);
}

function walk(value: unknown, depth: number, maxString: number, maxDepth: number, maxItems: number): unknown {
	if (value === null || value === undefined) return value;
	switch (typeof value) {
		case "string":
			return redactString(value, maxString);
		case "number":
		case "boolean":
			return value;
		case "bigint":
			return value.toString();
		case "function":
		case "symbol":
			return "<unsupported>";
	}
	if (depth >= maxDepth) {
		return `<max-depth ${depth}>`;
	}
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		const limit = Math.min(value.length, maxItems);
		for (let i = 0; i < limit; i += 1) {
			out.push(walk(value[i], depth + 1, maxString, maxDepth, maxItems));
		}
		if (value.length > limit) {
			out.push(`<+${value.length - limit} more items>`);
		}
		return out;
	}
	if (typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		const keys = Object.keys(source);
		let count = 0;
		for (const key of keys) {
			if (count >= maxItems) break;
			if (isSensitiveKey(key)) {
				out[key] = "<redacted>";
				count += 1;
				continue;
			}
			let child: unknown;
			try {
				child = source[key];
			} catch {
				out[key] = "<unreadable>";
				count += 1;
				continue;
			}
			out[key] = walk(child, depth + 1, maxString, maxDepth, maxItems);
			count += 1;
		}
		if (keys.length > count) {
			out["<truncated>"] = `<+${keys.length - count} more keys>`;
		}
		return out;
	}
	return "<unsupported>";
}

/** Sanitized JSON text for export. Never throws. */
export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(sanitizeValue(value));
	} catch {
		return JSON.stringify("<unserializable>");
	}
}

export interface ContentShape {
	kind: "text" | "image" | "thinking" | "toolCall" | "other";
	bytes: number;
	/** Short, redacted preview. Empty unless previews were explicitly requested. */
	preview: string;
}

/**
 * Describe one content block without exposing its body by default.
 * `detail` opts into a truncated, redacted preview.
 */
export function describeContentBlock(block: unknown, detail = false, maxPreview = 120): ContentShape {
	if (!block || typeof block !== "object") {
		const text = typeof block === "string" ? block : "";
		return { kind: "other", bytes: byteSize(block), preview: detail ? redactString(text, maxPreview) : "" };
	}
	const rec = block as Record<string, unknown>;
	const type = typeof rec.type === "string" ? rec.type : "other";
	if (type === "text" && typeof rec.text === "string") {
		return { kind: "text", bytes: byteSize(rec.text), preview: detail ? redactString(rec.text, maxPreview) : "" };
	}
	if (type === "thinking") {
		const thinking = typeof rec.thinking === "string" ? rec.thinking : "";
		return { kind: "thinking", bytes: byteSize(thinking), preview: "<thinking>" };
	}
	if (type === "image") {
		const data = typeof rec.data === "string" ? rec.data : "";
		const mime = typeof rec.mimeType === "string" ? rec.mimeType : "unknown";
		return { kind: "image", bytes: data.length, preview: `<image ${mime} bytes=${data.length}>` };
	}
	if (type === "toolCall") {
		const args = rec.arguments;
		return {
			kind: "toolCall",
			bytes: byteSize(args),
			preview: detail ? `<toolCall ${String(rec.name ?? "?")}>` : "",
		};
	}
	return { kind: "other", bytes: byteSize(block), preview: detail ? `<${type}>` : "" };
}
