/**
 * Run state machine: running / paused / finalizing / done / failed / cancelled (PRD §7, §14).
 * Rate limiting and lost authentication are pausable, not fatal.
 */
import { CancelledError } from '../shared/errors';

export type EngineState =
	'idle' | 'running' | 'paused' | 'finalizing' | 'done' | 'failed' | 'cancelled';

export type PauseReason =
	'rate-limited' | 'challenge' | 'auth' | 'network' | 'failures' | 'tab-lost';

export interface PauseInfo {
	reason: PauseReason;
	/** Epoch ms of the automatic resume, or null when only the user can resume. */
	resumeAt: number | null;
}

export interface StateHistoryEntry {
	state: EngineState;
	reason?: PauseReason;
	at: number;
}

export interface RunSnapshot {
	state: EngineState;
	pause: PauseInfo | null;
}

const TERMINAL: EngineState[] = ['done', 'failed', 'cancelled'];

export class RunController {
	private current: EngineState = 'idle';
	private pauseInfo: PauseInfo | null = null;
	private resumeTimer: ReturnType<typeof setTimeout> | null = null;
	private waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
	private listeners = new Set<(snapshot: RunSnapshot) => void>();
	private readonly abortController = new AbortController();
	readonly history: StateHistoryEntry[] = [];

	get state(): EngineState {
		return this.current;
	}

	get pause(): PauseInfo | null {
		return this.pauseInfo;
	}

	/** Aborted on cancel; in-flight work listens to stop early. */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get cancelled(): boolean {
		return this.current === 'cancelled';
	}

	snapshot(): RunSnapshot {
		return { state: this.current, pause: this.pauseInfo };
	}

	subscribe(listener: (snapshot: RunSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}

	private transition(state: EngineState, reason?: PauseReason): void {
		this.current = state;
		this.history.push({ state, ...(reason ? { reason } : {}), at: Date.now() });
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}

	private clearTimer(): void {
		if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
		this.resumeTimer = null;
	}

	start(): void {
		if (this.current !== 'idle') throw new Error(`Cannot start from ${this.current}`);
		this.transition('running');
	}

	/**
	 * Pause the run. `autoResumeMs: null` waits for the user. Pausing while already paused keeps
	 * the stricter outcome: a user-only pause is never downgraded to an automatic one, and an
	 * automatic resume is only ever pushed later.
	 */
	pauseRun(reason: PauseReason, autoResumeMs: number | null): void {
		if (this.current !== 'running' && this.current !== 'paused') return;
		const resumeAt = autoResumeMs === null ? null : Date.now() + autoResumeMs;
		if (this.current === 'paused' && this.pauseInfo) {
			const existing = this.pauseInfo;
			if (existing.resumeAt === null) return;
			if (resumeAt !== null && resumeAt <= existing.resumeAt) return;
		}
		this.clearTimer();
		this.pauseInfo = { reason, resumeAt };
		if (autoResumeMs !== null) {
			this.resumeTimer = setTimeout(() => this.resume(), autoResumeMs);
		}
		this.transition('paused', reason);
	}

	resume(): void {
		if (this.current !== 'paused') return;
		this.clearTimer();
		this.pauseInfo = null;
		this.transition('running');
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.resolve();
	}

	/** Resolves once the run is running; rejects with CancelledError once it never will be. */
	whenRunning(): Promise<void> {
		if (this.current === 'running') return Promise.resolve();
		if (this.current === 'paused') {
			return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
		}
		return Promise.reject(new CancelledError());
	}

	throwIfStopped(): void {
		if (this.current !== 'running' && this.current !== 'paused') throw new CancelledError();
	}

	finalizing(): void {
		if (this.current !== 'running') throw new CancelledError();
		this.transition('finalizing');
	}

	done(): void {
		if (this.current !== 'finalizing') return;
		this.transition('done');
	}

	fail(): void {
		if (TERMINAL.includes(this.current)) return;
		this.stop('failed');
	}

	cancel(): void {
		if (TERMINAL.includes(this.current)) return;
		this.stop('cancelled');
	}

	private stop(state: 'failed' | 'cancelled'): void {
		this.clearTimer();
		this.pauseInfo = null;
		this.transition(state);
		this.abortController.abort();
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.reject(new CancelledError());
	}
}
