/**
 * Builds the pma-validate fixture archives: one valid, one valid-but-partial, and a set of
 * archives that each break exactly one rule of the Portable Map Archive 1.0-draft spec.
 *
 * Everything here is hand-written from the spec; nothing comes from the extension source.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeZip } from './zip-writer.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

interface FixtureEntry {
	name: string;
	json?: Json;
	text?: string;
	bytes?: Uint8Array;
	store?: boolean;
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

const NATIVE_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="${GPX_NS}" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns:vendor="https://example.com/vendor/1" version="1.1" creator="Example Source">
  <metadata><name>Morning Ridge Run</name><time>2025-08-03T14:00:00Z</time></metadata>
  <trk>
    <name>Morning Ridge Run</name>
    <extensions><vendor:color>#ff0000</vendor:color></extensions>
    <trkseg>
      <trkpt lat="36.5785" lon="-118.2923"><ele>2550.1</ele><time>2025-08-03T14:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>121</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="36.5790" lon="-118.2931"><ele>2561.4</ele><time>2025-08-03T14:00:30Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>128</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="36.5797" lon="-118.2940"><ele>2570.0</ele><time>2025-08-03T14:01:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
`;

const SERIALIZED_TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="${GPX_NS}" version="1.1" creator="MapLiberator">
  <trk>
    <name>Evening Walk — Übergang</name>
    <trkseg>
      <trkpt lat="36.6000" lon="-118.3000"><ele>2000</ele></trkpt>
      <trkpt lat="36.6010" lon="-118.3010"><ele>2004</ele></trkpt>
    </trkseg>
  </trk>
</gpx>
`;

const ROUTE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="${GPX_NS}" version="1.1" creator="MapLiberator">
  <rte>
    <name>Mount Whitney Loop</name>
    <rtept lat="36.5869" lon="-118.2400"><ele>2550</ele></rtept>
    <rtept lat="36.5730" lon="-118.2660"><ele>3100</ele></rtept>
    <rtept lat="36.5785" lon="-118.2923"><ele>4421</ele></rtept>
  </rte>
</gpx>
`;

const HTML_CHALLENGE = `<!DOCTYPE html>
<html><head><title>Just a moment...</title></head>
<body><p>Checking your browser<br>before accessing the site.</body></html>
`;

/** Not a decodable image: validators must never read photo bytes. */
const fakeJpeg = (seed: number): Uint8Array => {
	const bytes = new Uint8Array(512);
	bytes.set([0xff, 0xd8, 0xff, 0xe0]);
	for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 17) & 0xff;
	return bytes;
};

const source = (id: string, extra: Json = {}): Json => ({
	platform: 'examplemaps',
	id,
	url: `https://maps.example.com/o/${id}`,
	...extra
});

/** The fully valid archive, as an ordered, mutable list of entries. */
function validModel(): FixtureEntry[] {
	return [
		{ name: 'tracks/000001-morning-ridge-run.gpx', text: NATIVE_TRACK_GPX },
		{
			name: 'tracks/000001-morning-ridge-run.json',
			json: {
				id: 'track/000001',
				kind: 'track',
				file: '000001-morning-ridge-run.gpx',
				geometrySource: 'native-gpx',
				name: 'Morning Ridge Run',
				description: 'Out and back along the ridge.',
				createdAt: '2025-08-03T14:00:00Z',
				updatedAt: '2025-08-04T09:30:00.250Z',
				activityType: 'running',
				visibility: 'private',
				tags: ['sierra', 'training'],
				stats: {
					distanceMeters: 212.4,
					ascentMeters: 19.9,
					durationSeconds: 60,
					pointCount: 3
				},
				source: source('trk-a1', {
					raw: { id: 'trk-a1', title: 'Morning Ridge Run', color: '#ff0000', nested: { n: 1 } }
				})
			}
		},
		{ name: 'tracks/000002-evening-walk-ubergang.gpx', text: SERIALIZED_TRACK_GPX },
		{
			name: 'tracks/000002-evening-walk-ubergang.json',
			json: {
				id: 'track/000002',
				kind: 'track',
				file: '000002-evening-walk-ubergang.gpx',
				geometrySource: 'serialized',
				name: 'Evening Walk — Übergang',
				description: null,
				createdAt: '2025-08-05T01:00:00Z',
				visibility: null,
				tags: [],
				stats: { distanceMeters: 142, pointCount: 2 },
				source: source('trk-b2')
			}
		},
		{ name: 'routes/000001-mount-whitney-loop.gpx', text: ROUTE_GPX },
		{
			name: 'routes/000001-mount-whitney-loop.json',
			json: {
				id: 'route/000001',
				kind: 'route',
				file: '000001-mount-whitney-loop.gpx',
				geometrySource: 'serialized',
				name: 'Mount Whitney Loop',
				createdAt: '2024-06-02T14:11:09Z',
				updatedAt: '2025-01-18T03:40:51Z',
				activityType: 'hiking',
				visibility: 'public',
				stats: { distanceMeters: 35420.5, ascentMeters: 1910, pointCount: 3 },
				source: source('rte-c3')
			}
		},
		{
			name: 'waypoints/waypoints.geojson',
			json: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'waypoint/000001',
						geometry: { type: 'Point', coordinates: [-118.2787, 36.5631, 3670] },
						properties: {
							name: 'Trail Camp',
							description: 'Last water.',
							createdAt: '2024-06-02T14:11:09Z',
							icon: 'campsite',
							tags: ['camp'],
							source: source('wpt-d4')
						}
					},
					{
						type: 'Feature',
						id: 'waypoint/000002',
						geometry: { type: 'Point', coordinates: [-118.24, 36.5869] },
						properties: { name: 'Whitney Portal', source: source('wpt-e5') }
					}
				]
			}
		},
		{
			name: 'areas/areas.geojson',
			json: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'area/000001',
						geometry: {
							type: 'Polygon',
							coordinates: [
								[
									[-118.3, 36.55],
									[-118.25, 36.55],
									[-118.25, 36.6],
									[-118.3, 36.6],
									[-118.3, 36.55]
								]
							]
						},
						properties: {
							name: 'Permit Zone',
							areaSquareMeters: 24800000,
							source: source('area-f6')
						}
					}
				]
			}
		},
		{ name: 'photos/000001-summit.jpg', bytes: fakeJpeg(1), store: true },
		{
			name: 'photos/000001-summit.json',
			json: {
				id: 'photo/000001',
				file: '000001-summit.jpg',
				contentType: 'image/jpeg',
				rendition: 'original',
				attachedTo: 'waypoint/000001',
				caption: 'Sunrise at Trail Camp',
				takenAt: '2025-08-03T18:22:10Z',
				uploadedAt: '2025-08-04T02:01:44Z',
				coordinate: [-118.2787, 36.5631],
				source: source('pho-g7')
			}
		},
		{ name: 'photos/000002-000002.jpg', bytes: fakeJpeg(2), store: true },
		{
			name: 'photos/000002-000002.json',
			json: {
				id: 'photo/000002',
				file: '000002-000002.jpg',
				contentType: 'image/jpeg',
				rendition: 'largest-available',
				attachedTo: null,
				source: source('pho-h8')
			}
		},
		{
			name: 'collections.json',
			json: {
				collections: [
					{
						id: 'collection/000001',
						name: 'Trips',
						parent: null,
						source: { platform: 'examplemaps', id: 'fld-1', url: null },
						members: [{ ref: 'track/000001' }, { ref: 'area/000001' }]
					},
					{
						id: 'collection/000002',
						name: 'Sierra 2025',
						description: 'Everything for the August trip.',
						parent: 'collection/000001',
						source: { platform: 'examplemaps', id: 'fld-2' },
						members: [
							{ ref: 'route/000001' },
							{ ref: 'waypoint/000001' },
							{ ref: 'track/000001' },
							{
								reference: {
									name: 'Kearsarge Pass Trail',
									source: {
										platform: 'examplemaps',
										id: 'trail-991',
										url: 'https://maps.example.com/trail/kearsarge-pass'
									},
									coordinate: [-118.37, 36.77]
								},
								annotations: {
									completedAt: '2025-08-03',
									rating: 5,
									review: 'Worth the climb.',
									notes: null
								}
							}
						]
					}
				]
			}
		},
		{ name: 'errors.json', json: [] },
		{
			name: 'manifest.json',
			json: {
				format: 'portable-map-archive',
				version: 1,
				createdAt: '2026-09-21T16:30:00Z',
				status: 'complete',
				part: { index: 1, of: 1 },
				generator: { name: 'pma-fixtures', version: '1.0.0' },
				source: {
					platform: 'examplemaps',
					adapterVersion: '1.0.0',
					account: { id: 'u-123', displayName: 'Sam H.' }
				},
				selection: {
					routes: 'included',
					tracks: 'included',
					waypoints: 'included',
					areas: 'included',
					collections: 'included',
					photos: 'included',
					rawSourceData: true
				},
				contents: { routes: 1, tracks: 2, waypoints: 2, areas: 1, collections: 2, photos: 2 },
				errors: { routes: 0, tracks: 0, waypoints: 0, areas: 0, collections: 0, photos: 0 }
			}
		}
	];
}

function doc(model: FixtureEntry[], name: string): Json {
	const entry = model.find((e) => e.name === name);
	if (!entry || entry.json === undefined) throw new Error(`fixture model has no JSON entry ${name}`);
	return entry.json;
}

function without(model: FixtureEntry[], name: string): FixtureEntry[] {
	return model.filter((e) => e.name !== name);
}

/** A partial archive: track/000003 and photo/000003 failed; both are still referenced. */
function partialModel(): FixtureEntry[] {
	const model = validModel();
	doc(model, 'collections.json').collections[1].members.push({ ref: 'track/000003' });
	doc(model, 'photos/000002-000002.json').attachedTo = 'track/000003';
	const errors = doc(model, 'errors.json') as Json[];
	errors.push(
		{
			type: 'track',
			id: 'track/000003',
			sourceId: 'trk-z9',
			adapter: 'examplemaps@1.0.0',
			error: 'HTTP 500'
		},
		{
			type: 'photo',
			id: 'photo/000003',
			sourceId: 'pho-y8',
			adapter: 'examplemaps@1.0.0',
			error: 'HTTP 404'
		},
		{
			type: 'waypoint',
			id: null,
			sourceId: null,
			adapter: 'examplemaps@1.0.0',
			error: 'unmappable record'
		}
	);
	const manifest = doc(model, 'manifest.json');
	manifest.status = 'partial';
	manifest.errors = { routes: 0, tracks: 1, waypoints: 1, areas: 0, collections: 0, photos: 1 };
	return model;
}

/** name → [model builder, error code the validator is expected to report] */
export const FIXTURES: Record<string, { build: () => FixtureEntry[]; expect: string | null }> = {
	valid: { build: validModel, expect: null },
	partial: { build: partialModel, expect: null },
	'missing-manifest': {
		build: () => without(validModel(), 'manifest.json'),
		expect: 'manifest-missing'
	},
	'unknown-major-version': {
		build: () => {
			const model = validModel();
			doc(model, 'manifest.json').version = 2;
			return model;
		},
		expect: 'unsupported-version'
	},
	'dangling-ref': {
		build: () => {
			const model = validModel();
			doc(model, 'collections.json').collections[0].members.push({ ref: 'route/000099' });
			return model;
		},
		expect: 'dangling-ref'
	},
	'dangling-attached-to': {
		build: () => {
			const model = validModel();
			doc(model, 'photos/000001-summit.json').attachedTo = 'waypoint/000404';
			return model;
		},
		expect: 'dangling-ref'
	},
	'dangling-parent': {
		build: () => {
			const model = validModel();
			doc(model, 'collections.json').collections[1].parent = 'collection/000077';
			return model;
		},
		expect: 'dangling-ref'
	},
	'path-traversal': {
		build: () => [{ name: '../evil.gpx', text: SERIALIZED_TRACK_GPX }, ...validModel()],
		expect: 'unsafe-name'
	},
	'path-traversal-nested': {
		build: () => [{ name: 'tracks/../../evil.gpx', text: SERIALIZED_TRACK_GPX }, ...validModel()],
		expect: 'unsafe-name'
	},
	'absolute-path': {
		build: () => [{ name: '/etc/evil.gpx', text: SERIALIZED_TRACK_GPX }, ...validModel()],
		expect: 'unsafe-name'
	},
	'backslash-path': {
		build: () => [{ name: 'tracks\\..\\evil.gpx', text: SERIALIZED_TRACK_GPX }, ...validModel()],
		expect: 'unsafe-name'
	},
	'manifest-not-last': {
		build: () => {
			const model = validModel();
			const manifest = model.pop();
			if (!manifest) throw new Error('empty model');
			return [manifest, ...model];
		},
		expect: 'manifest-not-last'
	},
	'count-mismatch': {
		build: () => {
			const model = validModel();
			doc(model, 'manifest.json').contents.tracks = 3;
			return model;
		},
		expect: 'count-mismatch'
	},
	'status-mismatch': {
		build: () => {
			const model = partialModel();
			doc(model, 'manifest.json').status = 'complete';
			return model;
		},
		expect: 'status-mismatch'
	},
	'orphan-sidecar': {
		build: () => {
			const model = without(validModel(), 'tracks/000002-evening-walk-ubergang.gpx');
			doc(model, 'manifest.json').contents.tracks = 1;
			return model;
		},
		expect: 'orphan-sidecar'
	},
	'missing-sidecar': {
		build: () => without(validModel(), 'photos/000002-000002.json'),
		expect: 'missing-sidecar'
	},
	'kind-mismatch': {
		build: () => {
			const model = validModel();
			doc(model, 'routes/000001-mount-whitney-loop.json').kind = 'track';
			return model;
		},
		expect: 'kind-mismatch'
	},
	'duplicate-id': {
		build: () => {
			const model = validModel();
			doc(model, 'waypoints/waypoints.geojson').features[1].id = 'waypoint/000001';
			return model;
		},
		expect: 'duplicate-id'
	},
	'bad-gpx': {
		build: () => {
			const model = validModel();
			const gpx = model.find((e) => e.name === 'tracks/000001-morning-ridge-run.gpx');
			if (!gpx) throw new Error('missing gpx entry');
			gpx.text = HTML_CHALLENGE;
			return model;
		},
		expect: 'gpx-invalid'
	},
	'empty-gpx': {
		build: () => {
			const model = validModel();
			const gpx = model.find((e) => e.name === 'routes/000001-mount-whitney-loop.gpx');
			if (!gpx) throw new Error('missing gpx entry');
			gpx.text = `<?xml version="1.0"?><gpx xmlns="${GPX_NS}" version="1.1" creator="x"><rte><name>Empty</name></rte></gpx>`;
			return model;
		},
		expect: 'gpx-invalid'
	},
	'bad-json': {
		build: () => {
			const model = validModel();
			const entry = model.find((e) => e.name === 'errors.json');
			if (!entry) throw new Error('missing errors.json');
			delete entry.json;
			entry.text = '[ {"type": "track", ';
			return model;
		},
		expect: 'json-invalid'
	},
	'schema-violation': {
		build: () => {
			const model = validModel();
			const sidecar = doc(model, 'tracks/000002-evening-walk-ubergang.json');
			sidecar.geometrySource = 'guessed';
			delete sidecar.stats;
			return model;
		},
		expect: 'schema'
	}
};

/** Writes every fixture archive into `dir` and returns fixture name → archive path. */
export async function buildFixtures(dir: string): Promise<Record<string, string>> {
	mkdirSync(dir, { recursive: true });
	const paths: Record<string, string> = {};
	for (const [name, fixture] of Object.entries(FIXTURES)) {
		const path = join(dir, `${name}.zip`);
		writeZip(
			path,
			fixture.build().map((entry) => ({
				name: entry.name,
				data:
					entry.bytes ??
					entry.text ??
					JSON.stringify(entry.json, null, '\t') + '\n',
				store: entry.store ?? false
			}))
		);
		paths[name] = path;
	}
	return paths;
}
