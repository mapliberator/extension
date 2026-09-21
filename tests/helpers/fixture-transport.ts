import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterTransport } from '../../src/shared/models.ts';

export function loadFixture<T = any>(adapter: 'gaia' | 'alltrails', name: string): T {
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

/** A transport that answers from fixtures: `routes` maps a URL pattern to a fixture (or value). */
export function fixtureTransport(
	routes: [RegExp, unknown][],
	requested: string[] = [],
	sentHeaders: (Record<string, string> | undefined)[] = []
): AdapterTransport {
	return {
		async getJson(url: string, headers?: Record<string, string>) {
			requested.push(url);
			sentHeaders.push(headers);
			const route = routes.find(([pattern]) => pattern.test(url));
			if (!route) throw new Error(`no fixture for ${url}`);
			return structuredClone(route[1]);
		}
	};
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}
