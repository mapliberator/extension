import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunController } from '../src/engine/state.ts';
import { CancelledError } from '../src/shared/errors.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RunController', () => {
	it('walks idle → running → finalizing → done and records history', () => {
		const run = new RunController();
		expect(run.state).toBe('idle');
		run.start();
		run.finalizing();
		run.done();
		expect(run.history.map((entry) => entry.state)).toEqual(['running', 'finalizing', 'done']);
	});

	it('auto-resumes after the cooldown and releases waiters', async () => {
		const run = new RunController();
		run.start();
		run.pauseRun('rate-limited', 60_000);
		expect(run.pause).toEqual({ reason: 'rate-limited', resumeAt: Date.now() + 60_000 });

		let released = false;
		const waiting = run.whenRunning().then(() => (released = true));
		await vi.advanceTimersByTimeAsync(59_999);
		expect(released).toBe(false);
		expect(run.state).toBe('paused');
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(run.state).toBe('running');
		expect(run.pause).toBeNull();
	});

	it('a lost session waits for the user: no timer ever resumes it', async () => {
		const run = new RunController();
		run.start();
		run.pauseRun('auth', null);
		await vi.advanceTimersByTimeAsync(24 * 3_600_000);
		expect(run.state).toBe('paused');
		run.resume();
		expect(run.state).toBe('running');
	});

	it('manual resume cancels the pending automatic one', async () => {
		const run = new RunController();
		run.start();
		run.pauseRun('challenge', 10_000);
		run.resume();
		run.pauseRun('auth', null);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(run.pause?.reason).toBe('auth');
	});

	it('never downgrades a user-only pause, and only ever pushes an automatic resume later', async () => {
		const run = new RunController();
		run.start();
		run.pauseRun('auth', null);
		run.pauseRun('rate-limited', 1000);
		expect(run.pause).toEqual({ reason: 'auth', resumeAt: null });
		run.resume();

		run.pauseRun('rate-limited', 10_000);
		run.pauseRun('network', 2_000);
		expect(run.pause?.reason).toBe('rate-limited');
		run.pauseRun('rate-limited', 30_000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(run.state).toBe('paused');
		await vi.advanceTimersByTimeAsync(20_000);
		expect(run.state).toBe('running');
	});

	it('cancel rejects waiters, aborts the signal and is terminal', async () => {
		const run = new RunController();
		run.start();
		run.pauseRun('auth', null);
		const waiting = run.whenRunning();
		run.cancel();
		await expect(waiting).rejects.toBeInstanceOf(CancelledError);
		expect(run.signal.aborted).toBe(true);
		await expect(run.whenRunning()).rejects.toBeInstanceOf(CancelledError);
		run.resume();
		run.pauseRun('network', 1);
		run.fail();
		expect(run.state).toBe('cancelled');
		expect(() => run.throwIfStopped()).toThrow(CancelledError);
	});

	it('notifies subscribers with state and pause info', () => {
		const run = new RunController();
		const seen: string[] = [];
		const unsubscribe = run.subscribe((snapshot) =>
			seen.push(snapshot.pause ? `${snapshot.state}:${snapshot.pause.reason}` : snapshot.state)
		);
		run.start();
		run.pauseRun('tab-lost', null);
		run.resume();
		unsubscribe();
		run.cancel();
		expect(seen).toEqual(['idle', 'running', 'paused:tab-lost', 'running']);
	});
});
