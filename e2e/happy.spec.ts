import type { Platform } from '../tools/fake-source/index.ts';
import { validateArchive } from '../tools/pma-validate/validate.ts';
import { readArchiveTree } from '../tools/pma-validate/reader.ts';
import { findSentinels, openArchive } from './archive.ts';
import {
	allSentinels,
	assertOnlyFakeSourceHosts,
	assertPatientPacing,
	expect,
	openExportPage,
	opfsExports,
	preflight,
	sourceTabs,
	test,
	waitForArchive
} from './fixtures.ts';

for (const platform of ['gaiagps', 'alltrails'] as const) {
	test(`happy path: full ${platform} export through popup → export page → source tab → worker → OPFS → download`, async ({
		context,
		extensionId,
		fake,
		requests,
		downloadsDir
	}) => {
		const expected = fake.expected(platform);
		const page = await openExportPage(context, extensionId, platform);
		await preflight(page, expected.account.displayName);
		fake.resetLog();
		await page.getByTestId('start-export').click();
		const archivePath = await waitForArchive(page, downloadsDir);
		await expect(page.getByTestId('done')).toHaveAttribute('data-status', 'complete');

		// (a) passes pma-validate
		const validation = await validateArchive(archivePath);
		expect(validation.errors).toEqual([]);
		expect(validation.valid).toBe(true);

		// (b) complete, counts exactly equal to the seeded counts
		const archive = await openArchive(archivePath);
		const manifest = archive.json('manifest.json');
		expect(manifest.status).toBe('complete');
		expect(manifest.contents).toEqual(expected.counts);
		expect(validation.counts).toEqual(expected.counts);
		expect(manifest.source.account).toEqual(expected.account);
		expect(archive.json('errors.json')).toEqual([]);

		// (c) manifest.json is the last ZIP entry
		expect(archive.names.at(-1)).toBe('manifest.json');

		// (d) native GPX byte-identical to what fake-source served, sidecars say native-gpx
		for (const [kind, dir, ids] of [
			['track', 'tracks', expected.ids.tracks],
			['route', 'routes', expected.ids.routes]
		] as const) {
			const sidecars = archive.names
				.filter((name) => name.startsWith(`${dir}/`) && name.endsWith('.json'))
				.map((name) => archive.json(name));
			expect(sidecars.map((sidecar) => sidecar.source.id)).toEqual(ids);
			for (const sidecar of sidecars) {
				expect(sidecar.geometrySource).toBe('native-gpx');
				const served = fake.nativeGpx(platform, kind, sidecar.source.id);
				expect(archive.read(`${dir}/${sidecar.file}`).equals(served)).toBe(true);
			}
		}

		// Invariant: sentinels appear nowhere in the archive.
		expect(findSentinels(archivePath, archive, allSentinels(platform))).toEqual({});

		// …while saved platform trails DO appear as references with name, URL and one coordinate.
		const members = archive
			.json('collections.json')
			.collections.flatMap((collection: { members: unknown[] }) => collection.members);
		expect(expected.references.length).toBeGreaterThan(0);
		for (const reference of expected.references) {
			const found = members.find(
				(member: any) => member.reference?.source.id === reference.sourceId
			) as any;
			expect(found, `reference to ${reference.name}`).toBeTruthy();
			expect(found.reference.name).toBe(reference.name);
			expect(found.reference.source.url).toBe(reference.url);
			expect(found.reference.coordinate).toEqual(reference.coordinate);
			expect(Object.keys(found.reference).sort()).toEqual(['coordinate', 'name', 'source']);
		}
		expect(await readArchiveTree(archivePath)).toContain(expected.references[0]!.name);

		// Invariant: network only to fake-source hosts. The recorder must have seen the source
		// tab's API calls and the worker's photo fetches, or the check would prove nothing.
		assertOnlyFakeSourceHosts(requests, fake);
		expect(requests.some((url) => url.startsWith(`${fake.origin(platform)}/api/`))).toBe(true);
		expect(requests.filter((url) => url.startsWith(fake.assetOrigin(platform)))).toHaveLength(
			expected.counts.photos
		);

		// Invariant: patient-user pacing, measured by the server.
		assertPatientPacing(fake, platform);

		// Cleanup happened: nothing staged, source tab closed.
		expect(await opfsExports(page)).toEqual([]);
		expect(sourceTabs(context, fake, platform)).toEqual([]);
	});
}
