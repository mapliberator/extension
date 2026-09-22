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
	// Listings are bare arrays (docs/phase0-findings.md).
	const summaries = (items: { summary: unknown }[]) => items.map((item) => item.summary);
	write('gaia', 'user', gaia.me);
	write('gaia', 'track-listing', summaries(gaia.tracks));
	write('gaia', 'track-detail', gaia.tracks[0]!.detail);
	write(
		'gaia',
		'foreign-track-detail',
		gaia.tracks.find((t) => t.summary.id === 'gt-9001')!.detail
	);
	write('gaia', 'route-listing', summaries(gaia.routes));
	write('gaia', 'route-detail', gaia.routes[0]!.detail);
	write('gaia', 'waypoint-listing', summaries(gaia.waypoints));
	write('gaia', 'area-listing', summaries(gaia.areas));
	write('gaia', 'area-detail', gaia.areas[0]!.detail);
	write('gaia', 'photo-listing', summaries(gaia.photos));
	write('gaia', 'folder-listing', summaries(gaia.folders));

	const alltrails = fixPort(fake.objects('alltrails'));
	// Envelopes as the real API sends them (docs/phase0-findings.md).
	const page = (key: string, items: unknown[]) => ({
		[key]: items,
		meta: { status: 'ok', items: items.length },
		pageInfo: { totalItemCount: items.length, itemCount: items.length, hasNextPage: false }
	});
	const one = (key: string, item: unknown) => ({ [key]: [item], meta: { status: 'ok', items: 1 } });
	write('alltrails', 'me', one('users', alltrails.me));
	write(
		'alltrails',
		'tracks-listing',
		page(
			'maps',
			alltrails.tracks.map((t) => t.summary)
		)
	);
	write('alltrails', 'track-detail', one('maps', alltrails.tracks[0]!.detail));
	write(
		'alltrails',
		'maps-listing',
		page(
			'maps',
			alltrails.maps.map((m) => m.summary)
		)
	);
	write('alltrails', 'map-detail', one('maps', alltrails.maps[0]!.detail));
	write(
		'alltrails',
		'lists-listing',
		page(
			'lists',
			alltrails.lists.map((l) => l.list)
		)
	);
	write('alltrails', 'list-items', { listItems: alltrails.lists[0]!.items });
	write('alltrails', 'trail', one('trails', alltrails.trails[0]));
	write('alltrails', 'photos-listing', page('photos', alltrails.photos));

	const strava = fixPort(fake.objects('strava'));
	write('strava', 'current-athlete', {
		currentAthlete: strava.me,
		pageContext: { loggedOutExperiment: null, features: {} }
	});
	const models = strava.activities.map((a) => a.summary);
	write('strava', 'activities-listing', {
		models,
		page: 1,
		perPage: 20,
		total: models.length
	});
	// The fallback request asks for these three streams only.
	const { latlng, altitude, time } = strava.activities[0]!.streams;
	write('strava', 'streams', { latlng, altitude, time });
	write('strava', 'routes-listing', {
		me: {
			id: String(strava.me.id),
			measurementPreference: 'meters',
			searchRoutes: {
				nodes: strava.routes,
				pageInfo: {
					endCursor: String(strava.routes.length - 1),
					startCursor: '0',
					hasNextPage: false,
					hasPreviousPage: false
				}
			}
		}
	});
	write('strava', 'photos-listing', { items: strava.photos, next_cursor: null, has_more: false });
} finally {
	await fake.close();
}
console.log('fixtures written');
