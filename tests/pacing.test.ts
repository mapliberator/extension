import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lane, parseRetryAfter, type AttemptOutcome } from '../src/engine/pacing.ts';
import { RunController } from '../src/engine/state.ts';
import type { Timings } from '../src/engine/timings.ts';
import { PRODUCTION_TIMINGS } from '../src/engine/timings.ts';
import { CancelledError, ItemError } from '../src/shared/errors.ts';

const TIMINGS: Timings = { ...PRODUCTION_TIMINGS, jitterMs: [30, 100] };

beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
afterEach(() => vi.useRealTimers());

function setup(options = { concurrency: 2, minIntervalMs: 150 }, hooks = {}) {
	const controller = new RunController();
	controller.start();
	const lane = new Lane(controller, options, TIMINGS, { random: () => 0.5, ...hooks });
	return { controller, lane };
}

/** An attempt function that replays scripted outcomes and records when it was dispatched. */
function scripted<T>(outcomes: AttemptOutcome<T>[], dispatches: number[] = []) {
	let index = 0;
	return {
		dispatches,
		attempt: async (): Promise<AttemptOutcome<T>> => {
			dispatches.push(Date.now());
			return outcomes[Math.min(index++, outcomes.length - 1)]!;
		}
	};
}

const ok = <T>(value: T): AttemptOutcome<T> => ({ type: 'ok', value });
const retry = (
	reason: 'rate-limited' | 'server' | 'network',
	extra = {}
): AttemptOutcome<never> => ({
	type: 'retry',
	reason,
	detail: reason === 'network' ? 'network error' : 'HTTP 5xx',
	...extra
});

describe('Lane pacing', () => {
	it('keeps a jittered floor between dispatches', async () => {
		const { lane } = setup();
		const dispatches: number[] = [];
		const jobs = Array.from({ length: 6 }, () =>
			lane.run(async () => {
				dispatches.push(Date.now());
				return ok(null);
			})
		);
		await vi.runAllTimersAsync();
		await Promise.all(jobs);
		const gaps = dispatches.slice(1).map((at, index) => at - dispatches[index]!);
		expect(gaps).toHaveLength(5);
		// floor 150 + jitter(30..100) with random = 0.5 → 215 ms
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(150 + 30);
		expect(Math.min(...gaps)).toBe(215);
	});

	it('never exceeds the concurrency limit', async () => {
		const { lane } = setup({ concurrency: 2, minIntervalMs: 0 });
		let inFlight = 0;
		let peak = 0;
		const jobs = Array.from({ length: 10 }, () =>
			lane.run(async () => {
				peak = Math.max(peak, ++inFlight);
				await new Promise((resolve) => setTimeout(resolve, 1000));
				inFlight--;
				return ok(null);
			})
		);
		await vi.runAllTimersAsync();
		await Promise.all(jobs);
		expect(peak).toBe(2);
		expect(lane.inFlight).toBe(0);
	});
});

describe('Lane retries', () => {
	it('backs off exponentially with jitter and succeeds within the attempt budget', async () => {
		const { lane } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted([retry('server'), retry('network'), retry('server'), ok('done')]);
		const result = lane.run(script.attempt);
		await vi.runAllTimersAsync();
		expect(await result).toBe('done');
		const gaps = script.dispatches.slice(1).map((at, index) => at - script.dispatches[index]!);
		// base 1000 × 2^(n-1) × (0.5 + 0.5·random) with random = 0.5
		expect(gaps).toEqual([750, 1500, 3000]);
	});

	it('honours Retry-After when it is longer than the backoff', async () => {
		const { lane } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted([retry('rate-limited', { retryAfterMs: 7000 }), ok(1)]);
		const result = lane.run(script.attempt);
		await vi.runAllTimersAsync();
		await result;
		expect(script.dispatches[1]! - script.dispatches[0]!).toBe(7000);
	});

	it('records an item error after 4 attempts on 5xx and keeps the run going', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted([retry('server')]);
		const result = lane.run(script.attempt);
		const assertion = expect(result).rejects.toMatchObject({
			name: 'ItemError',
			message: 'HTTP 5xx after 4 attempts'
		});
		await vi.runAllTimersAsync();
		await assertion;
		expect(script.dispatches).toHaveLength(4);
		expect(controller.state).toBe('running');
	});

	it('fails immediately, without retrying, on a definitive answer', async () => {
		const { lane } = setup();
		const script = scripted<never>([
			{ type: 'fail', error: new ItemError('http-404', 'HTTP 404') }
		]);
		await expect(lane.run(script.attempt)).rejects.toThrow('HTTP 404');
		expect(script.dispatches).toHaveLength(1);
	});

	it('lets a request opt out of pausing when attempts run out (native GPX → fallback)', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted([retry('rate-limited', { onExhausted: 'fail' })]);
		const assertion = expect(lane.run(script.attempt)).rejects.toBeInstanceOf(ItemError);
		await vi.runAllTimersAsync();
		await assertion;
		expect(controller.state).toBe('running');
	});
});

describe('Lane pauses', () => {
	it('persistent 429 pauses with an auto-resume cooldown, then retries the same request', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const outcomes = [...Array.from({ length: 4 }, () => retry('rate-limited')), ok('through')];
		const script = scripted(outcomes);
		const result = lane.run(script.attempt);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(script.dispatches).toHaveLength(4);
		expect(controller.pause?.reason).toBe('rate-limited');
		expect(controller.pause?.resumeAt).toBe(script.dispatches[3]! + TIMINGS.pauseCooldownMs);

		await vi.advanceTimersByTimeAsync(TIMINGS.pauseCooldownMs);
		expect(await result).toBe('through');
		expect(controller.state).toBe('running');
	});

	it('a long Retry-After becomes a visible pause instead of a silent sleep', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted([retry('rate-limited', { retryAfterMs: 252_000 }), ok(1)]);
		const result = lane.run(script.attempt);
		await vi.advanceTimersByTimeAsync(0);
		expect(controller.pause).toEqual({ reason: 'rate-limited', resumeAt: Date.now() + 252_000 });
		await vi.advanceTimersByTimeAsync(252_000);
		expect(await result).toBe(1);
	});

	it('a dead network pauses rather than failing items, and resumes on wake', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted([...Array.from({ length: 4 }, () => retry('network')), ok('awake')]);
		const result = lane.run(script.attempt);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(controller.pause?.reason).toBe('network');
		controller.resume(); // "Resume now"
		await vi.runAllTimersAsync();
		expect(await result).toBe('awake');
	});

	it('401 pauses for re-authentication until the user resumes; attempts are not consumed', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted<string>([{ type: 'pause', reason: 'auth' }, ok('signed in')]);
		const result = lane.run(script.attempt);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(controller.pause).toEqual({ reason: 'auth', resumeAt: null });
		expect(script.dispatches).toHaveLength(1);
		controller.resume();
		await vi.runAllTimersAsync();
		expect(await result).toBe('signed in');
	});

	it('a challenge page pauses with a cooldown', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted<number>([{ type: 'pause', reason: 'challenge' }, ok(1)]);
		const result = lane.run(script.attempt);
		await vi.advanceTimersByTimeAsync(0);
		expect(controller.pause?.reason).toBe('challenge');
		expect(controller.pause?.resumeAt).not.toBeNull();
		await vi.runAllTimersAsync();
		expect(await result).toBe(1);
	});

	it('a request that keeps pausing the run eventually becomes an item error', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const script = scripted<never>([{ type: 'pause', reason: 'challenge' }]);
		const assertion = expect(lane.run(script.attempt)).rejects.toBeInstanceOf(ItemError);
		await vi.runAllTimersAsync();
		await assertion;
		expect(script.dispatches).toHaveLength(TIMINGS.maxPausesPerRequest + 1);
		expect(controller.state).toBe('running');
	});

	it('holds queued requests while paused and dispatches nothing', async () => {
		const { lane, controller } = setup({ concurrency: 2, minIntervalMs: 150 });
		controller.pauseRun('auth', null);
		const script = scripted([ok(1)]);
		const jobs = [lane.run(script.attempt), lane.run(script.attempt)];
		await vi.advanceTimersByTimeAsync(600_000);
		expect(script.dispatches).toHaveLength(0);
		controller.resume();
		await vi.runAllTimersAsync();
		await Promise.all(jobs);
		expect(script.dispatches).toHaveLength(2);
	});

	it('the circuit breaker pauses after N consecutive exhausted requests; a success resets it', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		const failing = () =>
			lane.run(scripted([retry('server')]).attempt).catch((error: unknown) => error);

		for (let i = 0; i < TIMINGS.breakerThreshold - 1; i++) {
			const pending = failing();
			await vi.runAllTimersAsync();
			expect(await pending).toBeInstanceOf(ItemError);
		}
		expect(controller.state).toBe('running');
		await lane.run(scripted([ok(1)]).attempt); // resets the streak

		for (let i = 0; i < TIMINGS.breakerThreshold; i++) {
			expect(controller.state).toBe('running');
			const pending = failing();
			await vi.advanceTimersByTimeAsync(20_000);
			expect(await pending).toBeInstanceOf(ItemError);
		}
		expect(controller.pause?.reason).toBe('failures');
		await vi.advanceTimersByTimeAsync(TIMINGS.pauseCooldownMs);
		expect(controller.state).toBe('running');
	});
});

describe('Lane source-tab recovery', () => {
	it('pauses, recreates the tab, resumes and retries the in-flight request', async () => {
		const recoverTab = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 2000));
		});
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 }, { recoverTab });
		const script = scripted<string>([{ type: 'tab-lost' }, ok('recovered')]);
		const result = lane.run(script.attempt);
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.pause).toEqual({ reason: 'tab-lost', resumeAt: null });
		await vi.runAllTimersAsync();
		expect(await result).toBe('recovered');
		expect(recoverTab).toHaveBeenCalledTimes(1);
		expect(controller.history.map((entry) => entry.reason ?? entry.state)).toEqual([
			'running',
			'tab-lost',
			'running'
		]);
	});

	it('stays paused when recovery fails, and tries again when the user resumes', async () => {
		const recoverTab = vi
			.fn()
			.mockRejectedValueOnce(new Error('no tab'))
			.mockResolvedValue(undefined);
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 }, { recoverTab });
		const script = scripted<string>([{ type: 'tab-lost' }, { type: 'tab-lost' }, ok('back')]);
		const result = lane.run(script.attempt);
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.state).toBe('paused');
		controller.resume();
		await vi.runAllTimersAsync();
		expect(await result).toBe('back');
	});

	it('does not resume a pause that belongs to someone else (lost session during recovery)', async () => {
		let finishRecovery!: () => void;
		const recoverTab = () => new Promise<void>((resolve) => (finishRecovery = resolve));
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 }, { recoverTab });
		void lane.run(scripted<string>([{ type: 'tab-lost' }, ok('x')]).attempt);
		await vi.advanceTimersByTimeAsync(0);
		controller.resume();
		controller.pauseRun('auth', null);
		finishRecovery();
		await vi.advanceTimersByTimeAsync(0);
		expect(controller.pause?.reason).toBe('auth');
	});
});

describe('Lane cancellation', () => {
	it('rejects sleeping, in-flight and queued requests with CancelledError', async () => {
		const { lane, controller } = setup({ concurrency: 1, minIntervalMs: 0 });
		// Sleeping in backoff (15 s Retry-After is below the visible-pause threshold).
		const sleeping = lane.run(scripted([retry('server', { retryAfterMs: 15_000 })]).attempt);
		await vi.advanceTimersByTimeAsync(10);
		// In flight when the cancel arrives.
		const inFlight = lane.run(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5000));
			return ok('too late');
		});
		// Queued behind it.
		const queuedScript = scripted([ok(1)]);
		const queued = lane.run(queuedScript.attempt);
		const outcomes = Promise.allSettled([sleeping, inFlight, queued]);

		await vi.advanceTimersByTimeAsync(1000);
		controller.cancel();
		await vi.runAllTimersAsync();
		for (const outcome of await outcomes) {
			expect(outcome.status).toBe('rejected');
			expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(CancelledError);
		}
		expect(queuedScript.dispatches).toHaveLength(0);
		expect(lane.inFlight).toBe(0);
	});
});

describe('parseRetryAfter', () => {
	it('parses delta-seconds and HTTP dates', () => {
		expect(parseRetryAfter('120')).toBe(120_000);
		expect(parseRetryAfter('0')).toBe(0);
		const now = Date.parse('2026-09-21T12:00:00Z');
		expect(parseRetryAfter('Mon, 21 Sep 2026 12:04:12 GMT', now)).toBe(252_000);
		expect(parseRetryAfter('Mon, 21 Sep 2026 11:00:00 GMT', now)).toBe(0);
		expect(parseRetryAfter('soon')).toBeUndefined();
		expect(parseRetryAfter(undefined)).toBeUndefined();
	});
});
