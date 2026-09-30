import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/core/ring-buffer";

describe("RingBuffer", () => {
	it("stores items oldest-to-newest up to capacity", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		expect(ring.toArray()).toEqual([1, 2, 3]);
		expect(ring.size).toBe(3);
		expect(ring.dropped).toBe(0);
	});

	it("evicts the oldest item and counts the drop when full", () => {
		const ring = new RingBuffer<number>(3);
		for (const value of [1, 2, 3, 4, 5]) ring.push(value);
		expect(ring.toArray()).toEqual([3, 4, 5]);
		expect(ring.size).toBe(3);
		expect(ring.dropped).toBe(2);
	});

	it("returns the newest items first from last()", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		expect(ring.last(5)).toEqual([2, 1]);
		ring.push(3);
		ring.push(4);
		expect(ring.last(2)).toEqual([4, 3]);
	});

	it("clears contents and the dropped counter", () => {
		const ring = new RingBuffer<number>(2);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		expect(ring.dropped).toBe(1);
		ring.clear();
		expect(ring.toArray()).toEqual([]);
		expect(ring.size).toBe(0);
		expect(ring.dropped).toBe(0);
	});

	it("rejects invalid capacities", () => {
		expect(() => new RingBuffer(0)).toThrow(RangeError);
		expect(() => new RingBuffer(1.5)).toThrow(RangeError);
	});
});
