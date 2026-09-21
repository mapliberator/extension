/** `npm run fake-source -- --port 4610 --dataset small|large [--photos N] [--photo-bytes N] [--max-page-size N]` */
import { parseArgs } from 'node:util';
import { startFakeSource } from './index.ts';
import type { DatasetOptions, Platform } from './types.ts';

const { values } = parseArgs({
	options: {
		port: { type: 'string', short: 'p', default: '4610' },
		dataset: { type: 'string', short: 'd', default: 'small' },
		photos: { type: 'string' },
		'photo-bytes': { type: 'string' },
		'max-page-size': { type: 'string' },
		help: { type: 'boolean', short: 'h', default: false }
	}
});

function int(name: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value.replace(/_/g, ''));
	if (!Number.isInteger(n) || n < 0) {
		console.error(`fake-source: --${name} must be a non-negative integer`);
		process.exit(2);
	}
	return n;
}

if (values.help) {
	console.log(
		'Usage: tsx tools/fake-source/cli.ts [--port 4610] [--dataset small|large]\n' +
			'       [--photos N] [--photo-bytes N] [--max-page-size N]'
	);
	process.exit(0);
}
if (values.dataset !== 'small' && values.dataset !== 'large') {
	console.error('fake-source: --dataset must be "small" or "large"');
	process.exit(2);
}

const maxPageSize = int('max-page-size', values['max-page-size']);
const dataset: DatasetOptions =
	values.dataset === 'large'
		? {
				kind: 'large',
				photos: int('photos', values.photos),
				photoBytes: int('photo-bytes', values['photo-bytes']),
				maxPageSize
			}
		: { kind: 'small', maxPageSize };

const fake = await startFakeSource({ port: int('port', values.port), dataset });

console.log(`fake-source listening on port ${fake.port} (dataset: ${dataset.kind})\n`);
for (const platform of ['gaiagps', 'alltrails'] as Platform[]) {
	const cookie = fake.sessionCookie(platform);
	const counts = fake.expected(platform).counts;
	console.log(`${platform}`);
	console.log(`  site    ${fake.origin(platform)}`);
	console.log(`  cdn     ${fake.assetOrigin(platform)}`);
	console.log(`  cookie  ${cookie.name}=${cookie.value}`);
	console.log(
		`  devtools: document.cookie is no use (HttpOnly) — POST ${fake.origin(platform)}/login`
	);
	console.log(
		`            or: curl -H 'Cookie: ${cookie.name}=${cookie.value}' ${fake.origin(platform)}/api/...`
	);
	console.log(`  expected ${JSON.stringify(counts)}\n`);
}
console.log(`control: POST /__control/login|logout?platform=…, POST /__control/faults,`);
console.log(
	`         GET /__control/stats?platform=…, GET /__control/log, POST /__control/reset-log`
);

let closing = false;
const shutdown = (): void => {
	if (closing) return;
	closing = true;
	fake.close().then(
		() => process.exit(0),
		() => process.exit(1)
	);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
