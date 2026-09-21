/**
 * Writes adapter fixtures from tools/fake-source's seeded dataset.
 *
 * Until the Phase 0 probes record real responses, these stand in for "recorded, scrubbed
 * fixtures": same shapes the adapters are developed against, with credentials and e-mail
 * addresses scrubbed the way a recorded fixture would be before it is committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTINELS, startFakeSource } from '../tools/fake-source/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');

function scrub(json: string): string {
	return json
		.replaceAll(SENTINELS.email, 'me@example.test')
		.replaceAll(SENTINELS.otherUserEmail, 'someone-else@example.test')
		.replaceAll(SENTINELS.csrfToken, 'scrubbed');
}

function write(dir: string, name: string, value: unknown): void {
	mkdirSync(join(ROOT, dir, 'fixtures'), { recursive: true });
	writeFileSync(
		join(ROOT, dir, 'fixtures', `${name}.json`),
		scrub(JSON.stringify(value, null, '\t')) + '\n'
	);
}

const fake = await startFakeSource({ port: 0, dataset: 'small' });
try {
	// Fixture URLs must not depend on the ephemeral port.
	const fixPort = <T>(value: T): T =>
		JSON.parse(JSON.stringify(value).replaceAll(`:${fake.port}`, ':4610')) as T;

	const gaia = fixPort(fake.objects('gaiagps'));
	const gaiaListing = (results: unknown[]) => ({
		count: results.length,
		next: null,
		previous: null,
		results
	});
	write('gaia', 'me', gaia.me);
	write('gaia', 'track-listing', gaiaListing(gaia.tracks.map((track) => track.summary)));
	write('gaia', 'track-detail', gaia.tracks[0]!.detail);
	write('gaia', 'route-listing', gaiaListing(gaia.routes.map((route) => route.summary)));
	write('gaia', 'route-detail', gaia.routes[0]!.detail);
	write('gaia', 'waypoint-listing', gaiaListing(gaia.waypoints));
	write('gaia', 'area-listing', gaiaListing(gaia.areas));
	write('gaia', 'photo-listing', gaiaListing(gaia.photos));
	write('gaia', 'folder-listing', gaiaListing(gaia.folders));

	const alltrails = fixPort(fake.objects('alltrails'));
	const atListing = (items: unknown[]) => ({ items, meta: { nextCursor: null } });
	write('alltrails', 'me', alltrails.me);
	write(
		'alltrails',
		'activities-listing',
		atListing(alltrails.activities.map((activity) => activity.summary))
	);
	write('alltrails', 'activity-detail', alltrails.activities[0]!.detail);
	write('alltrails', 'maps-listing', atListing(alltrails.maps.map((map) => map.summary)));
	write('alltrails', 'map-detail', alltrails.maps[0]!.detail);
	write('alltrails', 'lists-listing', atListing(alltrails.lists));
	write('alltrails', 'completed-listing', atListing(alltrails.completed));
	write('alltrails', 'photos-listing', atListing(alltrails.photos));
} finally {
	await fake.close();
}
console.log('fixtures written');
