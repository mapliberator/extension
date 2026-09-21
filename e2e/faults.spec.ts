import type { Fault } from '../tools/fake-source/index.ts';
import { validateArchive } from '../tools/pma-validate/validate.ts';
import { findSentinels, openArchive } from './archive.ts';
import {
	allSentinels,
	assertOnlyFakeSourceHosts,
	assertPatientPacing,
	downloadedFiles,
	expect,
	openExportPage,
	opfsExports,
	preflight,
	sourceTabs,
	test,
	waitForArchive
} from './fixtures.ts';

const gaia = 'gaiagps' as const;

// Seeded items that fail permanently, whatever the engine tries.
const FAILING_TRACK = 'gt-3005';
const FAILING_ROUTE = 'gr-4002';
const FAILING_PHOTO = 'gp-7003';
const SLOW_TRACK = 'gt-3002';

const FAULTS: Fault[] = [
	// Permanently failing items: both geometry paths of one track and one route, one photo.
	{
		platform: gaia,
		match: `^/api/v3/track/${FAILING_TRACK}/$`,
		action: { kind: 'status', status: 500 }
	},
	{
		platform: gaia,
		match: `^/api/v3/route/${FAILING_ROUTE}(\\.gpx|/)$`,
		action: { kind: 'status', status: 500 }
	},
	{ platform: gaia, match: `^/photos/${FAILING_PHOTO}/`, action: { kind: 'status', status: 404 } },
	// Slow JSON fallback for one track, so the test can kill the source tab mid-request.
	{
		platform: gaia,
		match: `^/api/v3/track/${SLOW_TRACK}/$`,
		count: 1,
		action: { kind: 'delay', ms: 4000 }
	},
	// GPX endpoints for tracks are gated.
	{ platform: gaia, match: '^/api/v3/track/[^/]+\\.gpx$', action: { kind: 'status', status: 403 } },
	// Transient 429s with Retry-After: absorbed by engine retries.
	{
		platform: gaia,
		match: '^/api/v3/track/\\?',
		count: 2,
		action: { kind: 'status', status: 429, retryAfter: 1 }
	},
	// Persistent 429s: circuit opens → paused (rate-limited) → automatic resume.
	{
		platform: gaia,
		match: '^/api/v3/route/\\?',
		count: 5,
		action: { kind: 'status', status: 429 }
	},
	// HTML challenge page where JSON was expected → paused until the user resumes.
	{ platform: gaia, match: '^/api/v3/waypoint/\\?', count: 1, action: { kind: 'challenge' } },
	// Dropped connections. Mid-response, because Chromium itself silently re-sends a GET whose
	// reused socket died before any response bytes — a second hit the engine never issued, which
	// would muddy the pacing measurement below.
	{
		platform: gaia,
		match: '^/api/v3/area/\\?',
		count: 2,
		action: { kind: 'drop', when: 'mid-response' }
	},
	// …and one reset before any response bytes, on the photo CDN (no pacing floor there).
	{ platform: gaia, match: '^/photos/gp-7001/', count: 1, action: { kind: 'drop' } },
	// Mid-run session expiry.
	{ platform: gaia, match: '^/api/v3/photo/\\?', count: 1, action: { kind: 'expire-session' } }
];

test('faults: 429s, challenge, dropped connection, session expiry, killed source tab, gated GPX → pauses, resumes, completes as partial', async ({
	context,
	extensionId,
	fake,
	requests,
	downloadsDir
}) => {
	const expected = fake.expected(gaia);
	const page = await openExportPage(context, extensionId, gaia);
	await preflight(page, expected.account.displayName);
	fake.setFaults(FAULTS);
	fake.resetLog();
	await page.getByTestId('start-export').click();
	const paused = page.getByTestId('paused');

	// Kill the source tab while a request is in flight: recreate, re-inject, retry.
	await expect
		.poll(() => fake.log().some((entry) => entry.path === `/api/v3/track/${SLOW_TRACK}/`), {
			timeout: 60_000
		})
		.toBe(true);
	const [sourceTab] = sourceTabs(context, fake, gaia);
	expect(sourceTab).toBeTruthy();
	await sourceTab!.close();
	await expect(page.getByTestId('export-page')).toHaveAttribute(
		'data-history',
		/paused\(tab-lost\) running/,
		{ timeout: 30_000 }
	);
	expect(sourceTabs(context, fake, gaia)).toHaveLength(1);

	// Persistent 429 → paused with a countdown → resumes by itself.
	await expect(paused).toHaveAttribute('data-reason', 'rate-limited', { timeout: 60_000 });
	await expect(page.getByTestId('auto-resume')).toBeVisible();
	await expect(page.getByTestId('export-page')).toHaveAttribute(
		'data-history',
		/paused\(rate-limited\) running/,
		{ timeout: 30_000 }
	);

	// Challenge page → paused → the user resumes.
	await expect(paused).toHaveAttribute('data-reason', 'challenge', { timeout: 60_000 });
	await page.getByTestId('resume').click();

	// Session expiry → paused, no auto-resume → sign in again → resume.
	await expect(paused).toHaveAttribute('data-reason', 'auth', { timeout: 60_000 });
	await expect(page.getByTestId('auto-resume')).toHaveCount(0);
	fake.login(gaia);
	await page.getByTestId('resume').click();

	const archivePath = await waitForArchive(page, downloadsDir);
	await expect(page.getByTestId('done')).toHaveAttribute('data-status', 'partial');

	const validation = await validateArchive(archivePath);
	expect(validation.errors).toEqual([]);
	expect(validation.valid).toBe(true);

	const archive = await openArchive(archivePath);
	const manifest = archive.json('manifest.json');
	expect(manifest.status).toBe('partial');
	expect(archive.names.at(-1)).toBe('manifest.json');

	// Permanently failing seeded items appear in errors.json one-for-one.
	const errors =
		archive.json<{ type: string; sourceId: string; adapter: string; id: string }[]>('errors.json');
	expect(errors.map((entry) => `${entry.type}:${entry.sourceId}`).sort()).toEqual(
		[`track:${FAILING_TRACK}`, `route:${FAILING_ROUTE}`, `photo:${FAILING_PHOTO}`].sort()
	);
	for (const entry of errors) expect(entry.adapter).toBe('gaiagps@1.0.0');
	expect(manifest.errors).toEqual({
		tracks: 1,
		routes: 1,
		photos: 1,
		waypoints: 0,
		areas: 0,
		collections: 0
	});
	expect(manifest.contents).toEqual({
		...expected.counts,
		tracks: expected.counts.tracks - 1,
		routes: expected.counts.routes - 1,
		photos: expected.counts.photos - 1
	});

	// Gated objects fell back to the serializer; ungated ones stayed native and byte-identical.
	const sidecars = (dir: string) =>
		archive.names
			.filter((name) => name.startsWith(`${dir}/`) && name.endsWith('.json'))
			.map((name) => archive.json(name))
			// Entries land in completion order (two requests in flight); IDs follow enumeration order.
			.sort((a, b) => a.id.localeCompare(b.id));
	const tracks = sidecars('tracks');
	expect(tracks.map((sidecar) => sidecar.source.id)).toEqual(
		expected.ids.tracks.filter((id) => id !== FAILING_TRACK)
	);
	for (const sidecar of tracks) {
		expect(sidecar.geometrySource).toBe('serialized');
		expect(sidecar.stats.pointCount).toBeGreaterThan(0);
		expect(archive.read(`tracks/${sidecar.file}`).toString('utf8')).toContain('<trkseg>');
	}
	const routes = sidecars('routes');
	expect(routes.map((sidecar) => sidecar.source.id)).toEqual(
		expected.ids.routes.filter((id) => id !== FAILING_ROUTE)
	);
	for (const sidecar of routes) {
		expect(sidecar.geometrySource).toBe('native-gpx');
		expect(
			archive
				.read(`routes/${sidecar.file}`)
				.equals(fake.nativeGpx(gaia, 'route', sidecar.source.id))
		).toBe(true);
	}

	expect(findSentinels(archivePath, archive, allSentinels(gaia))).toEqual({});
	assertOnlyFakeSourceHosts(requests, fake);
	assertPatientPacing(fake, gaia);
	expect(await opfsExports(page)).toEqual([]);
});

test('faults: AllTrails login redirect mid-run pauses for re-authentication, then completes', async ({
	context,
	extensionId,
	fake,
	requests,
	downloadsDir
}) => {
	const platform = 'alltrails' as const;
	const expected = fake.expected(platform);
	const page = await openExportPage(context, extensionId, platform);
	await preflight(page, expected.account.displayName);
	fake.setFaults([
		{ platform, match: '/maps\\?', count: 1, action: { kind: 'expire-session' } },
		{ platform, match: '/export\\?format=gpx', skip: 1, count: 1, action: { kind: 'challenge' } }
	]);
	fake.resetLog();
	await page.getByTestId('start-export').click();

	const paused = page.getByTestId('paused');
	await expect(paused).toHaveAttribute('data-reason', 'auth', { timeout: 60_000 });
	fake.login(platform);
	await page.getByTestId('resume').click();

	const archivePath = await waitForArchive(page, downloadsDir);
	const validation = await validateArchive(archivePath);
	expect(validation.errors).toEqual([]);
	const archive = await openArchive(archivePath);
	const manifest = archive.json('manifest.json');
	expect(manifest.status).toBe('complete');
	expect(manifest.contents).toEqual(expected.counts);

	// An HTML page served with 200 on a GPX endpoint never reaches the archive: that one object
	// falls back to the serializer.
	const sources = archive.names
		.filter((name) => name.startsWith('tracks/') && name.endsWith('.json'))
		.map((name) => archive.json(name).geometrySource);
	expect(sources.filter((source: string) => source === 'serialized')).toHaveLength(1);
	for (const [name, bytes] of archive.all()) {
		if (name.endsWith('.gpx')) expect(bytes.toString('utf8')).not.toMatch(/<html/i);
	}

	expect(findSentinels(archivePath, archive, allSentinels(platform))).toEqual({});
	assertOnlyFakeSourceHosts(requests, fake);
	assertPatientPacing(fake, platform);
});

test('faults: schema drift on a listing endpoint fails the run, naming adapter and version', async ({
	context,
	extensionId,
	fake,
	downloadsDir
}) => {
	const page = await openExportPage(context, extensionId, gaia);
	await preflight(page, fake.expected(gaia).account.displayName);
	fake.setFaults([
		{ platform: gaia, match: '^/api/v3/waypoint/\\?', action: { kind: 'schema-drift' } }
	]);
	await page.getByTestId('start-export').click();

	await expect(page.getByTestId('failed')).toBeVisible({ timeout: 60_000 });
	const message = page.getByTestId('failure-message');
	await expect(message).toContainText('Gaia GPS adapter v1.0.0 is out of date');
	await expect(message).toContainText('waypoint listing');

	// Fatal: nothing is left behind.
	expect(await opfsExports(page)).toEqual([]);
	expect(downloadedFiles(downloadsDir)).toEqual([]);
	expect(sourceTabs(context, fake, gaia)).toEqual([]);
});
