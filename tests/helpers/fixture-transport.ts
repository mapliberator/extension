import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterTransport, CsrfSource } from '../../src/shared/models.ts';

export function loadFixture<T = any>(adapter: 'gaia' | 'alltrails' | 'strava', name: string): T {
	const path = join(
		import.meta.dirname,
		'..',
		'..',
		'src',
		'adapters',
		adapter,
		'fixtures',
		`${name}.json`
	);
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export interface PostedRequest {
	url: string;
	body: unknown;
	headers?: Record<string, string>;
	csrf?: CsrfSource;
}

/** A fixture, or a function of the POSTed body for answers that depend on it (paging). */
type FixtureAnswer = unknown | ((body: unknown) => unknown);

/** A transport that answers from fixtures: `routes` maps a URL pattern to a fixture (or value). */
export function fixtureTransport(
	routes: [RegExp, FixtureAnswer][],
	requested: string[] = [],
	sentHeaders: (Record<string, string> | undefined)[] = [],
	posted: PostedRequest[] = []
): AdapterTransport {
	const answer = (url: string, body?: unknown) => {
		const route = routes.find(([pattern]) => pattern.test(url));
		if (!route) throw new Error(`no fixture for ${url}`);
		const value =
			typeof route[1] === 'function' ? (route[1] as (b: unknown) => unknown)(body) : route[1];
		return structuredClone(value);
	};
	return {
		async getJson(url: string, headers?: Record<string, string>) {
			requested.push(url);
			sentHeaders.push(headers);
			return answer(url);
		},
		async postJson(url, body, options = {}) {
			requested.push(url);
			sentHeaders.push(options.headers);
			posted.push({ url, body: structuredClone(body), ...options });
			return answer(url, body);
		}
	};
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}
