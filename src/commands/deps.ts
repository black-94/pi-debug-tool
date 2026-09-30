import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { redactErrorText } from "../core/redaction";
import type { DebugRuntime } from "../runtime";
import type { DebugReport } from "../ui/present";
import type { ParsedArgs } from "./args";

/** Dependencies handed to each subcommand. */
export interface CommandDeps {
	pi: ExtensionAPI;
	runtime: DebugRuntime;
}

export type Subcommand = (args: ParsedArgs, ctx: ExtensionCommandContext, deps: CommandDeps) => Promise<DebugReport>;

export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Run a read-only probe, converting any failure into an "unavailable" result. */
export function safe<T>(fn: () => T): SafeResult<T> {
	try {
		return { ok: true, value: fn() };
	} catch (error) {
		return { ok: false, error: redactErrorText(error) };
	}
}

export function unavailable(reason: string): string {
	return `unavailable (${reason})`;
}
