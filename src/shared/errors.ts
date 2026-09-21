/** Failure taxonomy from PRD §12: fatal, pausable, item-level. */

export class CancelledError extends Error {
	constructor() {
		super('Export cancelled');
		this.name = 'CancelledError';
	}
}

/** Stops the run; the archive is discarded. */
export class FatalError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'FatalError';
		this.code = code;
	}
}

/** A listing response no longer matches the adapter's schema: we cannot know what we'd miss. */
export class AdapterOutdatedError extends FatalError {
	constructor(label: string, version: string, detail: string) {
		super(
			'adapter-outdated',
			`${label} adapter v${version} is out of date — check for an extension update. (${detail})`
		);
		this.name = 'AdapterOutdatedError';
	}
}

export class QuotaError extends FatalError {
	constructor(bytesWritten: number) {
		super(
			'quota',
			'MapLiberator could not complete the export because the browser does not have enough ' +
				`temporary storage available.\n\nProcessed: ${formatBytes(bytesWritten)}\n\n` +
				'Free additional disk space or export again without photos.'
		);
		this.name = 'QuotaError';
	}
}

/** One object failed; recorded in errors.json and the run continues. */
export class ItemError extends Error {
	/** Short machine-ish category for the diagnostic report (no names, IDs or URLs). */
	readonly category: string;
	constructor(category: string, message: string) {
		super(message);
		this.name = 'ItemError';
		this.category = category;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1000;
		unit++;
	} while (value >= 1000 && unit < units.length - 1);
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
