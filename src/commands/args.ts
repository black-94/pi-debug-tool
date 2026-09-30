export interface ParsedArgs {
	/** Non-flag tokens, in order. */
	positionals: string[];
	/** `--key=value`, `--key value`, and boolean `--key` flags. */
	flags: Record<string, string | boolean>;
}

/**
 * Tiny argument parser for slash-command input.
 *
 * Supports:
 *   sub positional --flag --key=value --key value
 *
 * A flag is treated as boolean when it is the last token or the next token
 * starts with `-`.
 */
export function parseArgs(input: string): ParsedArgs {
	const tokens = tokenize(input);
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i] as string;
		if (token === "--") {
			positionals.push(...tokens.slice(i + 1));
			break;
		}
		if (!token.startsWith("--") || token.length === 2) {
			positionals.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			flags[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		const next = tokens[i + 1];
		if (next !== undefined && !next.startsWith("-")) {
			flags[body] = next;
			i += 1;
			continue;
		}
		flags[body] = true;
	}

	return { positionals, flags };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
	const value = flags[key];
	return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
	const value = flags[key];
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	return value !== "false" && value !== "0" && value !== "";
}

export function flagNumber(flags: Record<string, string | boolean>, key: string, fallback: number): number {
	const value = flagString(flags, key);
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
