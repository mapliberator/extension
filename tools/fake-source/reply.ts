import type { PhotoSpec } from './photos.ts';

/** What a platform handler wants sent. The server turns it into bytes (and applies faults). */
export type Reply =
	| {
			kind: 'json';
			status: number;
			body: Record<string, unknown> | unknown[];
			/** Set on listings: the top-level array key that `schema-drift` renames. */
			listingKey?: string;
			/** Set on bare-array listings: `schema-drift` wraps the array in an envelope. */
			listing?: boolean;
	  }
	| { kind: 'bytes'; status: number; contentType: string; body: Buffer }
	/** 302 with an empty body. */
	| { kind: 'redirect'; location: string }
	| { kind: 'photo'; spec: PhotoSpec };

export interface ApiRequest {
	method: string;
	/** Path without the query string. */
	path: string;
	query: URLSearchParams;
	/** Lower-cased request headers. */
	headers: Record<string, string | string[] | undefined>;
}

export function json(status: number, body: Record<string, unknown>): Reply {
	return { kind: 'json', status, body };
}

export function parseIntParam(value: string | null, fallback: number): number {
	if (value === null || value === '') return fallback;
	return /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}
