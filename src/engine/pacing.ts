/**
 * Request pacing, retries and the circuit breaker (PRD §7). Adapters never retry; every request
 * to a platform goes through a Lane, which behaves like one patient user:
 *
 *  - fixed low concurrency and a jittered floor between dispatches;
 *  - exponential backoff with jitter on network errors, 5xx and 429, honoring Retry-After;
 *  - rate limiting, challenges, lost sessions and dead networks pause the run instead of failing.
 */
import { CancelledError, ItemError } from '../shared/errors';
import type { PauseReason, RunController } from './state';
import type { Timings } from './timings';

export type RetryReason = 'rate-limited' | 'server' | 'network';

export type AttemptOutcome<T> =
	| { type: 'ok'; value: T }
	| {
			type: 'retry';
			reason: RetryReason;
			/** Short description without names, IDs or URLs, e.g. "HTTP 503". */
			detail: string;
			retryAfterMs?: number;
			/** What to do once attempts run out. Defaults: rate-limited/network pause, server fails. */
			onExhausted?: 'pause' | 'fail';
	  }
	| { type: 'pause'; reason: Extract<PauseReason, 'auth' | 'challenge'> }
	| { type: 'tab-lost' }
	| { type: 'fail'; error: ItemError };

export interface LaneOptions {
	concurrency: number;
	/** Pacing floor between dispatches; 0 disables pacing (asset lane). */
	minIntervalMs: number;
}

export interface LaneHooks {
	/** Recreate the source tab after it died. Rejecting leaves the run paused for the user. */
	recoverTab?: () => Promise<void>;
	/** [0, 1) — injectable for tests. */
	random?: () => number;
}

export interface LaneEvent {
	type: 'dispatch' | 'retry' | 'exhausted';
	detail?: string;
}

const MAX_TAB_RECOVERIES_PER_REQUEST = 5;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new CancelledError());
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new CancelledError());
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export class Lane {
	private active = 0;
	private readonly queue: (() => void)[] = [];
	private nextDispatchAt = 0;
	private consecutiveFailures = 0;
	private readonly random: () => number;
	/** Observed by tests and the diagnostic report. */
	onEvent: ((event: LaneEvent) => void) | null = null;

	constructor(
		private readonly controller: RunController,
		private readonly options: LaneOptions,
		private readonly timings: Timings,
		private readonly hooks: LaneHooks = {}
	) {
		this.random = hooks.random ?? Math.random;
	}

	get inFlight(): number {
		return this.active;
	}

	private acquire(): Promise<void> {
		if (this.active < this.options.concurrency) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.queue.push(resolve));
	}

	private release(): void {
		const next = this.queue.shift();
		if (next) next();
		else this.active--;
	}

	private jitter(): number {
		const [min, max] = this.timings.jitterMs;
		return min + this.random() * (max - min);
	}

	/** Reserve the next dispatch time; returns how long this request must still wait. */
	private reserveDispatch(): number {
		if (this.options.minIntervalMs <= 0) return 0;
		const now = Date.now();
		const at = Math.max(now, this.nextDispatchAt);
		this.nextDispatchAt = at + this.options.minIntervalMs + this.jitter();
		return at - now;
	}

	/** A further request inside the current attempt: wait out the floor, like a dispatch. */
	private async paced(): Promise<void> {
		const wait = this.reserveDispatch();
		if (wait > 0) await sleep(wait, this.controller.signal);
		this.onEvent?.({ type: 'dispatch' });
	}

	private backoff(attempt: number): number {
		const exponential = this.timings.backoffBaseMs * 2 ** (attempt - 1);
		const capped = Math.min(exponential, this.timings.backoffMaxMs);
		return capped * (0.5 + this.random() * 0.5);
	}

	/**
	 * Run one logical request until it succeeds, fails for good, or the run is cancelled.
	 * `attempt` performs exactly one try and classifies the result. An attempt that needs a
	 * second request (a token first, then the query) awaits `paced()` before it, so the pacing
	 * floor holds between the two as between any others.
	 */
	async run<T>(attempt: (paced: () => Promise<void>) => Promise<AttemptOutcome<T>>): Promise<T> {
		let attempts = 0;
		let pauses = 0;
		let tabRecoveries = 0;

		for (;;) {
			await this.controller.whenRunning();
			await this.acquire();
			let outcome: AttemptOutcome<T>;
			try {
				const wait = this.reserveDispatch();
				if (wait > 0) await sleep(wait, this.controller.signal);
				if (this.controller.state !== 'running') continue;
				this.onEvent?.({ type: 'dispatch' });
				outcome = await attempt(() => this.paced());
			} finally {
				this.release();
			}
			this.controller.throwIfStopped();

			switch (outcome.type) {
				case 'ok':
					this.consecutiveFailures = 0;
					return outcome.value;

				case 'fail':
					// A definitive answer (404, bad item) proves the platform is responding.
					this.consecutiveFailures = 0;
					throw outcome.error;

				case 'pause':
					if (pauses >= this.timings.maxPausesPerRequest) {
						throw new ItemError(outcome.reason, `gave up after repeated ${outcome.reason} pauses`);
					}
					pauses++;
					attempts = 0;
					this.controller.pauseRun(
						outcome.reason,
						outcome.reason === 'auth' ? null : this.timings.pauseCooldownMs
					);
					continue;

				case 'tab-lost': {
					if (!this.hooks.recoverTab || tabRecoveries >= MAX_TAB_RECOVERIES_PER_REQUEST) {
						throw new ItemError('tab-lost', 'source tab was lost repeatedly');
					}
					tabRecoveries++;
					this.controller.pauseRun('tab-lost', null);
					try {
						await this.hooks.recoverTab();
						if (this.controller.pause?.reason === 'tab-lost') this.controller.resume();
					} catch {
						// Stay paused; the user's Resume triggers another recovery attempt.
					}
					continue;
				}

				case 'retry': {
					attempts++;
					const retryAfter =
						outcome.retryAfterMs === undefined
							? undefined
							: Math.min(outcome.retryAfterMs, this.timings.maxRetryAfterMs);
					const exhausted = attempts >= this.timings.maxAttempts;
					const longWait = retryAfter !== undefined && retryAfter > this.timings.longRetryAfterMs;
					const pausable = (outcome.onExhausted ?? defaultExhausted(outcome.reason)) === 'pause';

					if (pausable && (exhausted || longWait)) {
						if (pauses >= this.timings.maxPausesPerRequest) {
							throw new ItemError(outcome.reason, `${outcome.detail} (persistent)`);
						}
						pauses++;
						attempts = 0;
						this.onEvent?.({ type: 'exhausted', detail: outcome.detail });
						this.controller.pauseRun(
							outcome.reason === 'network' ? 'network' : 'rate-limited',
							Math.max(retryAfter ?? 0, longWait ? 0 : this.timings.pauseCooldownMs)
						);
						continue;
					}
					if (exhausted) {
						this.onEvent?.({ type: 'exhausted', detail: outcome.detail });
						this.consecutiveFailures++;
						if (this.consecutiveFailures >= this.timings.breakerThreshold) {
							this.consecutiveFailures = 0;
							this.controller.pauseRun('failures', this.timings.pauseCooldownMs);
						}
						throw new ItemError(
							outcome.reason,
							`${outcome.detail} after ${this.timings.maxAttempts} attempts`
						);
					}
					this.onEvent?.({ type: 'retry', detail: outcome.detail });
					await sleep(Math.max(retryAfter ?? 0, this.backoff(attempts)), this.controller.signal);
					continue;
				}
			}
		}
	}
}

function defaultExhausted(reason: RetryReason): 'pause' | 'fail' {
	return reason === 'server' ? 'fail' : 'pause';
}

/** `Retry-After` as delta-seconds or HTTP-date → milliseconds. */
export function parseRetryAfter(
	value: string | undefined | null,
	now = Date.now()
): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
