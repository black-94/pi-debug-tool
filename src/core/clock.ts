/**
 * Wall clock and monotonic clock.
 *
 * Durations always come from the monotonic source so they are immune to system
 * clock changes. The wall clock is only used for human-readable timestamps.
 */
export interface Clock {
	/** Wall-clock milliseconds since the Unix epoch. */
	wallNow(): number;
	/** Monotonic milliseconds, only meaningful as a difference. */
	monoNow(): number;
}

export const systemClock: Clock = {
	wallNow: () => Date.now(),
	monoNow: () => performance.now(),
};
