/** Page-side handle on the exporter worker: typed RPC plus progress events. */
import { FatalError } from '../shared/errors';
import type { WorkerEnvelope, WorkerReply, WorkerRequest, WorkerResults } from './worker-protocol';

/** The worker rejected a native GPX stream; the engine falls back to the JSON API. */
export class GpxRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GpxRejectedError';
	}
}

export class WorkerClient {
	private readonly worker: Worker;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	onProgress: ((bytesWritten: number) => void) | null = null;

	constructor(worker?: Worker) {
		this.worker = worker ?? new Worker('/exporter-worker.js');
		this.worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
			const reply = event.data;
			if ('event' in reply) {
				this.onProgress?.(reply.bytesWritten);
				return;
			}
			const entry = this.pending.get(reply.id);
			if (!entry) return;
			this.pending.delete(reply.id);
			if (reply.ok) return entry.resolve(reply.result);
			const { error } = reply;
			if (error.gpxCheck) return entry.reject(new GpxRejectedError(error.message));
			// Anything else going wrong inside the worker concerns the archive itself: fatal.
			entry.reject(new FatalError(error.fatalCode ?? 'archive', error.message));
		});
		this.worker.addEventListener('error', (event) => {
			this.failAll(new FatalError('worker', event.message || 'The export worker crashed'));
		});
	}

	private failAll(error: Error): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const entry of pending) entry.reject(error);
	}

	call<R extends WorkerRequest>(request: R): Promise<WorkerResults[R['op']]> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.worker.postMessage({ id, request } satisfies WorkerEnvelope);
		});
	}

	terminate(): void {
		this.worker.terminate();
		this.failAll(new FatalError('worker', 'The export worker was stopped'));
	}
}
