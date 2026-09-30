/**
 * Fixed-capacity ring buffer with an explicit dropped counter.
 *
 * When full, the oldest item is overwritten and `dropped` increases, so a
 * long-running session cannot grow the debug extension's memory without bound
 * and the UI can honestly report how much history it lost.
 */
export class RingBuffer<T> {
	private readonly buffer: Array<T | undefined>;
	private start = 0;
	private length = 0;
	private droppedCount = 0;

	constructor(readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
		}
		this.buffer = new Array<T | undefined>(capacity);
	}

	get size(): number {
		return this.length;
	}

	/** Number of items evicted because the buffer was full. */
	get dropped(): number {
		return this.droppedCount;
	}

	push(item: T): void {
		const index = (this.start + this.length) % this.capacity;
		if (this.length === this.capacity) {
			this.buffer[this.start] = item;
			this.start = (this.start + 1) % this.capacity;
			this.droppedCount += 1;
			return;
		}
		this.buffer[index] = item;
		this.length += 1;
	}

	/** Oldest-to-newest snapshot. */
	toArray(): T[] {
		const out: T[] = new Array(this.length);
		for (let i = 0; i < this.length; i += 1) {
			out[i] = this.buffer[(this.start + i) % this.capacity] as T;
		}
		return out;
	}

	/** Newest-to-oldest snapshot, capped at `limit`. */
	last(limit: number): T[] {
		const count = Math.max(0, Math.min(limit, this.length));
		const out: T[] = new Array(count);
		for (let i = 0; i < count; i += 1) {
			out[i] = this.buffer[(this.start + this.length - 1 - i + this.capacity * 2) % this.capacity] as T;
		}
		return out;
	}

	clear(): void {
		this.buffer.fill(undefined);
		this.start = 0;
		this.length = 0;
		this.droppedCount = 0;
	}
}
