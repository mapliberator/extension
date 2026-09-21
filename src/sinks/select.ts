import type { SinkKind } from './types';

/**
 * Feature detection, never browser sniffing: some Chromium forks disable the File System Access
 * API, and Firefox does not ship it (PRD §10).
 */
export function selectSinkKind(scope: object = globalThis): SinkKind {
	return 'showSaveFilePicker' in scope &&
		typeof (scope as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
		? 'direct'
		: 'opfs';
}
