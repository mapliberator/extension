/** Engine timing constants. Not user-configurable (PRD §7.1). */
export interface Timings {
	/** Attempts per request on network errors, 5xx and 429. */
	maxAttempts: number;
	backoffBaseMs: number;
	backoffMaxMs: number;
	/** Auto-resume cooldown for rate-limit / challenge / network pauses. */
	pauseCooldownMs: number;
	/** A Retry-After longer than this becomes a visible pause instead of a silent sleep. */
	longRetryAfterMs: number;
	maxRetryAfterMs: number;
	/** Consecutive requests that exhausted their retries before the circuit breaker pauses. */
	breakerThreshold: number;
	/** How often one request may pause the run before it becomes an item-level error. */
	maxPausesPerRequest: number;
	/** Added on top of the adapter's pacing floor: [min, max] ms. */
	jitterMs: [number, number];
}

export const PRODUCTION_TIMINGS: Timings = {
	maxAttempts: 4,
	backoffBaseMs: 1000,
	backoffMaxMs: 30_000,
	pauseCooldownMs: 5 * 60_000,
	longRetryAfterMs: 20_000,
	maxRetryAfterMs: 30 * 60_000,
	breakerThreshold: 5,
	maxPausesPerRequest: 2,
	jitterMs: [30, 100]
};

/**
 * The e2e build talks to tools/fake-source only. Waiting is shortened so fault-injection runs
 * finish in seconds; the pacing floor and concurrency — which the e2e suite measures — are not.
 */
export const E2E_TIMINGS: Timings = {
	...PRODUCTION_TIMINGS,
	backoffBaseMs: 100,
	backoffMaxMs: 800,
	pauseCooldownMs: 2500,
	longRetryAfterMs: 1500
};

export function timingsForMode(mode: string): Timings {
	return mode === 'e2e' ? E2E_TIMINGS : PRODUCTION_TIMINGS;
}
