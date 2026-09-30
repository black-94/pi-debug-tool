# pi-debug-tool

An **observer-only** debug extension for [Pi](https://github.com/earendil-works/pi) `0.99.x`.
It adds one user-invoked slash command, `/debug`, that inspects session state,
traces runs, summarizes metrics, and debugs **native MCP** without touching
model context.

> The model can never see anything this extension collects. It registers no
> tools, no skills, no prompt templates, no messages, and never modifies the
> context, system prompt, tool loadout, or provider payload.

---

## Safety model (highest priority)

The extension is built so that "zero context pollution" is a structural
property, not a promise:

- The only registration calls are `pi.on(...)` (observer handlers) and
  `pi.registerCommand("debug", ...)`.
- It does **not** subscribe to `mcp_servers_change`. Handling that event marks an
  extension as the one that connects registered MCP servers; this extension only
  reads `pi.getMcpServers()` on demand from `/debug mcp`.
- Every event handler is wrapped so it **always returns `undefined`** and
  swallows its own errors. It therefore cannot replace a payload, block a tool,
  append an entry, or request a continuation.
- It never calls `registerTool`, `setActiveTools`, `sendMessage`,
  `sendUserMessage`, `appendEntry`, `registerMessageRenderer`,
  `registerEntryRenderer`, `registerMarkdownTransformer`, `registerProvider`,
  `registerMcpServer`, `unregisterMcpServer`, `registerShortcut`,
  `registerFlag`, `setSessionName`, `setLabel`, `setModel`, `setThinkingLevel`,
  `exec`, or `events.emit`.
- It never connects, calls, reconnects, starts, stops, or toggles an MCP server,
  and never runs `pi mcp` as a subprocess.
- Commands only render to the UI (a TUI overlay, or a notification in other
  modes). The **only** command that writes a file is `/debug export`, and only
  when the user explicitly invokes it.
- No state is persisted as session entries or custom messages.

This is enforced by tests:

- `tests/observer-only.test.ts` spies on every forbidden API and fails if any is
  called, asserts all handlers return `undefined`, asserts events are never
  mutated, asserts no `mcp_servers_change` handler is registered, and statically
  scans `src/**/*.ts` for forbidden call patterns.
- `tests/zero-context-pollution.test.ts` captures the system prompt, system
  prompt options, active tools, session projection, branch, and entries before
  and after running **every** command (including all `/debug mcp` forms) and
  asserts they are byte-for-byte identical.

---

## Install

Local directory (recommended while developing):

```bash
pi install ./pi-debug-tool
# or load for a single invocation without installing:
pi --extension ./extensions/debug.ts
```

Pi loads the TypeScript entry directly via jiti; no build step is required to use
the extension.

---

## Commands

One root command, dispatched by the first argument:

| Command | Description |
|---|---|
| `/debug` or `/debug status` | session/cwd/mode/trust/idle/pending/model/thinking/context-usage/branch + a read-only metrics summary |
| `/debug mcp [overview\|tools\|calls\|doctor] [server] [--server NAME] [--limit N]` | native MCP inventory, exposure, and call metadata (observer-only) |
| `/debug resources [tools\|commands\|skills\|mcp]` | public-API resource inventory; `tools` distinguishes active vs all with `sourceInfo` |
| `/debug context [summary\|sections\|messages] [--detail] [--limit N]` | read-only canonical projection + system-prompt/options summary |
| `/debug trace on\|off\|status\|tail [--limit N]` | in-memory ring buffer of safe metadata events |
| `/debug timeline [--limit N]` | run/turn/toolCall-correlated text timeline (parallel tools supported) |
| `/debug stats [session\|tools\|cache\|context\|errors]` | statistics with explicit denominators |
| `/debug doctor` | conservative, fact-based hints only |
| `/debug export jsonl\|markdown [path] [--force]` | write a redacted export (the only file write) |
| `/debug clear` | clear this extension's own trace/metrics only |
| `/debug help` | usage and safety notes |

`/debug` defaults to `status`. Unknown subcommands print the available list
instead of failing.

---

## Architecture

```
extensions/debug.ts        Pi entry (re-exports the factory)
src/
  extension.ts             factory: observers + /debug command
  runtime.ts               all mutable in-memory state
  observers.ts             observer-only event wiring, fail-closed
  core/
    clock.ts               wall clock + monotonic clock (durations)
    ring-buffer.ts         fixed capacity + dropped counter
    trace-store.ts         correlation (run/turn/request/message/tool) + ring
    metrics.ts             counters, tool durations, usage totals
    session-metrics.ts     pure derivation over public session entries
    inspectors.ts          read-only projection/resource summaries
    mcp-native.ts          MCP tool identity/inventory + bounded call metadata
    redaction.ts           secret redaction, label/error sanitizing, bounding
    format.ts              formatting helpers
    types.ts               shared types
  commands/                one module per subcommand + dispatcher
  ui/present.ts            TUI overlay with notify fallback
tests/                     vitest suite (see "Testing")
```

Correlation uses **local counters** where Pi exposes no native id, and says so
in the UI:

- `run` — incremented on `agent_start`.
- `turn` — Pi's `turnIndex` from `turn_start`/`turn_end`.
- `request` — incremented on `before_provider_request`.
- `msg` — incremented on `message_start`.
- `tool` — Pi's native `toolCallId` (the only native id).

Durations are always computed from the monotonic clock; wall-clock time is only
used for display.

---

## Public API boundary

Only documented public exports are used, and only for reading:

- `ExtensionAPI`: `on`, `events`, `registerCommand`, `getAllTools`,
  `getActiveTools`, `getCommands`, `getMcpServers`.
- `ExtensionContext` / `ExtensionCommandContext`: `ui`, `mode`, `hasUI`, `cwd`,
  `sessionManager` (read-only methods), `model`, `thinkingLevel`, `isIdle`,
  `isProjectTrusted`, `hasPendingMessages`, `getContextUsage`,
  `getSystemPrompt`, `getSystemPromptOptions`.
- `ReadonlySessionManager`: `getSessionId`, `getSessionFile`, `getCwd`,
  `getSessionName`, `getLeafId`, `getBranch`, `buildSessionProjection`,
  `getEntries`, `getTree`, `getHeader`.

No private/deep imports, no internal runner access, no monkey patching, no
reflection on private fields. Anything not available through these APIs is
reported as `unavailable` rather than guessed.

---

## Native MCP debugging (`/debug mcp`)

Pi 0.99 connects MCP servers itself and registers their tools as
`mcp__<server>__<tool>` with exposure `direct`, `codemode`, `codemode-deferred`,
`deferred`, or `hidden` (see Pi's `docs/mcp.md`). `/debug mcp` debugs this native
integration through public APIs only. There is **no dependency on
`pi-mcp-adapter`** and no adapter protocol, channel, cache, or compatibility
layer.

What it can tell you (evidence-based):

- **Tool inventory** from `getAllTools()`: per server/tool exposure, plus the
  distinction between *registered*, *declared* (`getActiveTools()`), *callable*
  (reachable from `ctx.executeTool()`/codemode, derived from exposure), and
  *hidden*. `codemode`/`deferred` tools are callable even though they are not
  declared — that is expected and never reported as "unavailable".
- **Extension registrations** from `getMcpServers()`: names and the registering
  extension path only. These are session registrations, *not* `mcp.json`
  entries, and *not* connection state.
- **Which source provides `/mcp`** from `getCommands()`: Pi's built-in MCP
  integration registers `/mcp` with a synthetic `builtin:` source, so a
  non-builtin `/mcp` command is the documented signal that built-in MCP support
  is replaced. A built-in `/mcp` is never reported as a replacement.
- **Call metadata** from native `tool_execution_start`/`tool_execution_end`:
  per server/tool call counts, error counts, mean/p95/max durations, nested
  (codemode/tool) calls via `parentToolCallId`, and max concurrency. Counts are
  kept even when tracing is off. With `/debug trace on`, `/debug mcp calls` also
  prints a bounded per-call detail table (`toolCallId`, `parentToolCallId`,
  server, tool, status, duration) read from the trace ring.

Identity is conservative: the namespace (`mcp__<server>`) resolves the server
exactly even when the server name contains `__`; when only the tool name is
available and the split would be ambiguous, or when the namespace and name
disagree, the server is reported as **unknown**, never guessed. Unknown exposure
is shown as `?` (unknown callable state), not `no`.

What it **cannot** know (Pi exposes no public API) and therefore reports as
`unavailable`, pointing you at `/mcp` and `pi mcp list`:

| Fact | Why unavailable |
|---|---|
| connection status (connected/failed/needs-auth), reconnect state | not exposed to extensions |
| enabled/disabled, the configured server list from `mcp.json` | not exposed to extensions |
| server definitions, transport, url/command, env, headers, credentials, OAuth | not exposed to extensions |
| resources, prompts, logging, per-server errors | not exposed to extensions |

`/debug doctor` never warns that an adapter is "absent" and never claims a server
is connected: a tool being registered or a successful call being observed is
*evidence of a call*, not proof of the current connection state.

---

## Privacy defaults

- Events carry **metadata only**: sizes, counts, ids, levels, statuses. Tool
  arguments/results, prompt text, thinking text, and image bytes are reduced to
  byte sizes and never stored.
- Message bodies are omitted from `/debug context messages` unless `--detail` is
  passed, and previews are then truncated and redacted.
- `after_provider_response` records only the status and the header **count**,
  never header values.
- High-frequency `message_update` / `tool_execution_update` events update
  counters only, so the ring buffer cannot be flooded.
- Tracing is **off by default**. Counters and tool durations are cheap metadata
  and are always maintained, so `/debug stats` works without enabling tracing.
  MCP call counts/errors/durations and parent correlation are likewise always
  maintained; only the per-call detail table needs tracing.
- MCP metadata is metadata only: server/tool names, call ids, status flags,
  counts, and durations. Tool arguments, results, and error text are never
  stored, and `getMcpServers()` config (url/command/env/headers/credentials) is
  never copied. Metadata labels (server, tool, path, id) are control-character
  neutralized and length-bounded; API exception text is bounded and has
  `Bearer`/`token=` secrets masked.
- Exports run every record through `sanitizeValue`, which removes values for
  keys matching authorization/cookie/api key/secret/token/bearer/credential,
  fully redacts base64 blobs, bounds depth/width/string length, and never
  includes thinking content. Export files are written with mode `0600`, refuse
  to overwrite without `--force`, refuse directory targets and symlinks, and
  refuse paths outside `cwd`, the home directory, and the temp directory.

### Statistics definitions (explicit denominators)

- **Tool error rate** = `tool_execution_end` with `isError` ÷ all
  `tool_execution_end`. Started-but-unfinished calls are excluded.
- **Session toolResult error rate** = errored `toolResult` messages ÷ all
  `toolResult` messages.
- **cacheReadShare / cacheWriteShare** = `cacheRead` (or `cacheWrite`) ÷
  (`input + cacheRead + cacheWrite`), where `input` counts non-cached prompt
  tokens as reported by the provider.
- **Cache hit ratio is not computed.** Providers expose cache read/write token
  counts, not hit counts, and Pi exposes no such counter.
- **Context usage percent** is Pi's `ContextUsage.percent`, which is already a
  0–100 percentage of the context window (`30` means 30%, **not** 0.30). It is
  formatted directly and clamped to `[0, 100]`; `null` (tokens unknown, e.g.
  right after compaction) is reported as unavailable. Health thresholds are
  applied on the normalized fraction: `< 80%` ok, `≥ 80%` info, `≥ 90%` warn.
  Internal ratios such as tool error rate and `cacheReadShare` remain 0–1 and
  are scaled by 100 for display.
- Percentiles are nearest-rank over the last 200 durations per tool.

---

## Testing

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # emits type declarations to dist/
npm test            # vitest --run
npm run check       # typecheck + tests
```

Coverage highlights: zero-context-pollution and observer-only guarantees,
static forbidden-API scan (including `registerMcpServer`/`unregisterMcpServer`
and `mcp_servers_change`), registration surface, native MCP identity parsing
(ambiguity/conflict), exposure classification (registered/declared/callable/
hidden), unknown-state degradation, MCP call aggregation (parallel calls, nested
codemode correlation, duplicate/unpaired ends, bounded maps), built-in vs
third-party `/mcp` detection, label/error sanitizing, ring-buffer capacity and
drops, parallel-tool correlation, metric denominators and cache accounting,
redaction, command dispatch, and export path safety.

---

## Known limitations / not implemented in v0.1

- **No per-extension handler timings/results**, no complete extension registry,
  and no retry/queue internal scheduling details: Pi exposes no public API for
  these, so `/debug doctor` lists them as deliberately unavailable.
- **No cache hit counts** (see above).
- **No MCP connection state, server definitions, transports, or credentials** are
  ever shown: Pi exposes no public API for them. `/debug mcp` reports them as
  `unavailable` and points at `/mcp` and `pi mcp list`. A registered tool or an
  observed successful call is never presented as proof of a live connection.
- **MCP per-call detail requires `/debug trace on`** and is bounded by the trace
  ring capacity; the per-tool aggregate table needs no tracing.
- **Ambiguous/conflicting MCP tool names report the server as unknown**, never a
  guessed server.
- **Trace data is in-memory only** and is cleared on `session_shutdown`; it is
  not persisted to the session. Use `/debug export` if you want a durable copy.
- **Tracing is off by default**; `/debug timeline` and `/debug trace tail`
  require `/debug trace on`.
- **`/debug context messages --detail` previews are truncated and redacted** by
  design; the extension never prints full sensitive bodies.
- The default export path is `<cwd>/debug-exports/`; pass an explicit path to
  write elsewhere (within cwd/home/temp).

## License

MIT — see [LICENSE](./LICENSE).
