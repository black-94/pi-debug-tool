import { describe, expect, it } from "vitest";
import { TraceStore } from "../src/core/trace-store";
import { groupByRunTurn } from "../src/commands/timeline";
import { createDebugExtension } from "../src/extension";
import { createFakeClock, createFakeContextEvent, createFakePi } from "./helpers/fakes";

describe("TraceStore correlation", () => {
	it("correlates tools with run/turn and computes monotonic durations", () => {
		const clock = createFakeClock();
		const store = new TraceStore({ capacity: 100, clock });
		store.setEnabled(true);

		const runId = store.noteRunStart();
		store.noteTurn(0);
		const first = store.beginTool("t1", "bash", 10);
		clock.advance(100);
		const second = store.beginTool("t2", "grep", 20);
		clock.advance(50);
		store.endTool("t1", 100, false);
		clock.advance(20);
		store.endTool("t2", 200, true);

		expect(runId).toBe(1);
		expect(first.runId).toBe(1);
		expect(first.turnIndex).toBe(0);
		expect(second.runId).toBe(1);
		expect(second.turnIndex).toBe(0);

		const t1 = store.getTool("t1");
		const t2 = store.getTool("t2");
		expect(t1?.durationMs).toBe(150);
		expect(t2?.durationMs).toBe(70);
		expect(t1?.isError).toBe(false);
		expect(t2?.isError).toBe(true);
		expect(t1?.finished).toBe(true);
	});

	it("does not double-count a completed tool end", () => {
		const clock = createFakeClock();
		const store = new TraceStore({ capacity: 10, clock });
		store.beginTool("t1", "bash");
		clock.advance(5);
		store.endTool("t1", 1, false);
		expect(store.endTool("t1", 1, false)).toBeUndefined();
	});

	it("records ring entries only while enabled, but always counts metrics", () => {
		const clock = createFakeClock();
		const store = new TraceStore({ capacity: 10, clock });
		store.record("lifecycle", "agent_start");
		expect(store.events()).toHaveLength(0);
		expect(store.snapshotMetrics().events.recorded).toBe(0);

		store.setEnabled(true);
		store.record("lifecycle", "agent_start");
		expect(store.events()).toHaveLength(1);
		expect(store.snapshotMetrics().events.recorded).toBe(1);
	});

	it("reports dropped entries when the ring overflows", () => {
		const clock = createFakeClock();
		const store = new TraceStore({ capacity: 2, clock });
		store.setEnabled(true);
		for (let i = 0; i < 5; i += 1) store.record("lifecycle", `e${i}`);
		expect(store.events()).toHaveLength(2);
		expect(store.snapshotMetrics().events.dropped).toBe(3);
	});
});

describe("parallel tool correlation through observers", () => {
	it("keeps distinct tool ids and durations for interleaved calls", () => {
		const clock = createFakeClock();
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock });
		runtime.trace.setEnabled(true);
		const ctx = createFakeContextEvent();

		const call = (event: string, payload: Record<string, unknown>): void => {
			for (const handler of fake.handlers.get(event) ?? []) handler({ type: event, ...payload }, ctx);
		};

		call("agent_start", {});
		call("turn_start", { turnIndex: 0 });
		call("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		clock.advance(100);
		call("tool_execution_start", { toolCallId: "t2", toolName: "grep", args: { pattern: "x" } });
		clock.advance(50);
		call("tool_execution_end", { toolCallId: "t1", toolName: "bash", result: { ok: true }, isError: false });
		clock.advance(20);
		call("tool_execution_end", { toolCallId: "t2", toolName: "grep", result: { ok: true }, isError: true });

		const observations = runtime.trace.getToolObservations();
		expect(observations).toHaveLength(2);
		const byId = new Map(observations.map((observation) => [observation.toolCallId, observation]));
		expect(byId.get("t1")?.durationMs).toBe(150);
		expect(byId.get("t2")?.durationMs).toBe(70);
		expect(byId.get("t1")?.runId).toBe(1);
		expect(byId.get("t2")?.turnIndex).toBe(0);

		const events = runtime.trace.events();
		const toolEvents = events.filter((event) => event.kind === "tool");
		expect(toolEvents.map((event) => event.name)).toEqual([
			"tool_execution_start",
			"tool_execution_start",
			"tool_execution_end",
			"tool_execution_end",
		]);
		expect(toolEvents[2]?.toolCallId).toBe("t1");
		expect(toolEvents[3]?.toolCallId).toBe("t2");
		expect(toolEvents[2]?.durationMs).toBe(150);
		expect(toolEvents[3]?.durationMs).toBe(70);

		const grouped = groupByRunTurn(events);
		const run = grouped.get("1");
		expect(run).toBeDefined();
		// turn 0 holds turn_start plus the four interleaved tool events.
		expect(run?.get("0")).toHaveLength(5);
	});

	it("counts high-frequency updates without filling the ring", () => {
		const fake = createFakePi();
		const runtime = createDebugExtension(fake.pi, { clock: createFakeClock() });
		runtime.trace.setEnabled(true);
		const ctx = createFakeContextEvent();
		const handler = fake.handlers.get("message_update")?.[0];
		for (let i = 0; i < 50; i += 1) handler?.({ type: "message_update", message: {}, assistantMessageEvent: {} }, ctx);
		expect(runtime.trace.events()).toHaveLength(0);
		expect(runtime.trace.snapshotMetrics().messages.updates).toBe(50);
	});
});
