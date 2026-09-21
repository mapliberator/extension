/** Progress metrics available to the UI (PRD §14). No byte-total prediction, no ETA. */
import { PLURAL, type ObjectType } from '../shared/schemas';

export type PluralType = (typeof PLURAL)[ObjectType];

export interface TypeProgress {
	selected: boolean;
	done: number;
	errors: number;
	/** null when the platform offers no cheap count. */
	total: number | null;
	finished: boolean;
}

export interface ProgressSnapshot {
	types: Record<PluralType, TypeProgress>;
	bytesWritten: number;
	/** Local display only; never leaves the page. */
	currentName: string | null;
	errorCount: number;
	/** 0..1, weighted by object counts, or null when no totals are known. */
	overall: number | null;
}

export const TYPE_ORDER: ObjectType[] = [
	'route',
	'track',
	'waypoint',
	'area',
	'collection',
	'photo'
];

export class ProgressStore {
	private readonly listeners = new Set<(snapshot: ProgressSnapshot) => void>();
	private data: ProgressSnapshot;
	private scheduled = false;

	constructor() {
		const types = {} as Record<PluralType, TypeProgress>;
		for (const type of TYPE_ORDER) {
			types[PLURAL[type]] = { selected: false, done: 0, errors: 0, total: null, finished: false };
		}
		this.data = { types, bytesWritten: 0, currentName: null, errorCount: 0, overall: null };
	}

	snapshot(): ProgressSnapshot {
		return this.data;
	}

	subscribe(listener: (snapshot: ProgressSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.data);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.data = { ...this.data, overall: this.computeOverall() };
			for (const listener of this.listeners) listener(this.data);
		});
	}

	private update(type: ObjectType, patch: Partial<TypeProgress>): void {
		const key = PLURAL[type];
		this.data = {
			...this.data,
			types: { ...this.data.types, [key]: { ...this.data.types[key], ...patch } }
		};
		this.emit();
	}

	select(type: ObjectType, total: number | null): void {
		this.update(type, { selected: true, total });
	}

	itemDone(type: ObjectType, name: string | null): void {
		this.data = { ...this.data, currentName: name };
		this.update(type, { done: this.data.types[PLURAL[type]].done + 1 });
	}

	itemFailed(type: ObjectType): void {
		this.data = { ...this.data, errorCount: this.data.errorCount + 1 };
		this.update(type, { errors: this.data.types[PLURAL[type]].errors + 1 });
	}

	/** Enumeration ended: the real total is now known exactly. */
	typeFinished(type: ObjectType): void {
		const current = this.data.types[PLURAL[type]];
		this.update(type, { finished: true, total: current.done + current.errors });
	}

	bytes(bytesWritten: number): void {
		this.data = { ...this.data, bytesWritten };
		this.emit();
	}

	private computeOverall(): number | null {
		let known = 0;
		let processed = 0;
		for (const progress of Object.values(this.data.types)) {
			if (!progress.selected) continue;
			const handled = progress.done + progress.errors;
			if (progress.total === null) {
				if (!progress.finished) return null;
				continue;
			}
			known += Math.max(progress.total, handled);
			processed += handled;
		}
		return known === 0 ? null : Math.min(1, processed / known);
	}
}
