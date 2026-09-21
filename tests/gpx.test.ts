import { describe, expect, it } from 'vitest';
import {
	countPoints,
	escapeXml,
	isValidPoint,
	serializeGpx,
	type GpxMeta
} from '../src/archive/gpx.ts';
import { GpxCheckError, GpxStreamCheck } from '../src/archive/gpx-check.ts';
import type { TrackPoint } from '../src/shared/models.ts';

const META: GpxMeta = {
	name: 'Ridge <run> & "friends"',
	description: 'Line 1\nLine 2 \u0007bell',
	time: '2024-06-02T14:11:09Z',
	type: 'hiking',
	creator: 'MapLiberator'
};

const SEGMENTS: TrackPoint[][] = [
	[
		{ lon: -118.2922881234, lat: 36.5785811234, ele: 2447.912, time: '2024-06-02T14:11:09Z' },
		{ lon: -118.292112, lat: 36.578739, ele: null, time: null }
	],
	[],
	[{ lon: 10, lat: 50 }]
];

const serialize = (meta = META, segments = SEGMENTS) => [...serializeGpx(meta, segments)].join('');

describe('serializeGpx', () => {
	it('writes GPX 1.1 with dense geometry as <trk>, never <rte>', () => {
		const gpx = serialize();
		expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"')).toBe(true);
		expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
		expect(gpx).toContain('<trk>');
		expect(gpx).not.toContain('<rte');
		expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);
	});

	it('writes one <trkseg> per non-empty segment', () => {
		expect(serialize().match(/<trkseg>/g)).toHaveLength(2);
	});

	it('rounds coordinates, writes optional <ele>/<time> only when present', () => {
		const gpx = serialize();
		expect(gpx).toContain(
			'<trkpt lat="36.5785811" lon="-118.2922881"><ele>2447.91</ele><time>2024-06-02T14:11:09Z</time></trkpt>'
		);
		expect(gpx).toContain('<trkpt lat="36.578739" lon="-118.292112"></trkpt>');
	});

	it('escapes markup and strips characters XML cannot carry', () => {
		const gpx = serialize();
		expect(gpx).toContain('<name>Ridge &lt;run&gt; &amp; &quot;friends&quot;</name>');
		expect(gpx).not.toContain('\u0007');
		expect(escapeXml('a\uD800b')).toBe('ab');
		expect(escapeXml('ok 🏔️')).toBe('ok 🏔️');
	});

	it('produces output that passes the GPX stream check with the right point count', () => {
		const check = new GpxStreamCheck();
		for (const chunk of serializeGpx(META, SEGMENTS)) check.write(chunk);
		expect(check.finish()).toEqual({ pointCount: 3 });
		expect(countPoints(SEGMENTS)).toBe(3);
	});

	it('yields bounded chunks for large tracks', () => {
		const big: TrackPoint[][] = [
			Array.from({ length: 5000 }, (_, i) => ({ lon: i / 1e4, lat: 45, ele: i }))
		];
		const chunks = [...serializeGpx(META, big)];
		expect(chunks.length).toBeGreaterThan(10);
		expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(100_000);
		const check = new GpxStreamCheck();
		chunks.forEach((chunk) => check.write(chunk));
		expect(check.finish().pointCount).toBe(5000);
	});
});

describe('isValidPoint', () => {
	it('rejects non-finite and out-of-range coordinates', () => {
		expect(isValidPoint({ lon: 0, lat: 0 })).toBe(true);
		expect(isValidPoint({ lon: Number.NaN, lat: 0 })).toBe(false);
		expect(isValidPoint({ lon: 181, lat: 0 })).toBe(false);
		expect(isValidPoint({ lon: 0, lat: -90.1 })).toBe(false);
	});
});

describe('GpxStreamCheck', () => {
	const run = (...chunks: string[]) => {
		const check = new GpxStreamCheck();
		chunks.forEach((chunk) => check.write(chunk));
		return check.finish();
	};
	const GPX =
		'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gaia="https://example.test/gaia">' +
		'<metadata><extensions><gaia:color>#f00</gaia:color></extensions></metadata>' +
		'<trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1" lon="2"><ele>3</ele></trkpt></trkseg></trk>' +
		'<rte><rtept lat="1" lon="2"/></rte><wpt lat="1" lon="2"/></gpx>';

	it('accepts well-formed GPX and counts track and route points (not waypoints)', () => {
		expect(run(GPX)).toEqual({ pointCount: 3 });
	});

	it('gives the same answer however the stream is chunked', () => {
		for (const size of [1, 7, 64]) {
			const chunks = GPX.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))!;
			expect(run(...chunks)).toEqual({ pointCount: 3 });
		}
	});

	it('accepts a leading BOM and prefixed element names', () => {
		expect(
			run('\uFEFF<g:gpx xmlns:g="x"><g:rte><g:rtept lat="1" lon="2"/></g:rte></g:gpx>')
		).toEqual({ pointCount: 1 });
	});

	it('rejects an HTML page as soon as it cannot be GPX, and stays failed', () => {
		const check = new GpxStreamCheck();
		expect(() => check.write('<html><head><title>Sign in</title>')).toThrow(
			/root element is <html>/
		);
		expect(() => check.write('</head></html>')).toThrow(GpxCheckError);
		expect(() => check.finish()).toThrow(GpxCheckError);

		const doctype = new GpxStreamCheck();
		expect(() => doctype.write('<!doctype html><html>')).toThrow(GpxCheckError);
	});

	it('rejects JSON, truncated documents, empty bodies and GPX without points', () => {
		expect(() => run('{"detail":"Forbidden"}')).toThrow(GpxCheckError);
		expect(() => run('<gpx><trk><trkseg><trkpt lat="1" lon="2">')).toThrow(/well-formed/);
		expect(() => run('')).toThrow(GpxCheckError);
		expect(() => run('<gpx><wpt lat="1" lon="2"/></gpx>')).toThrow(/no track or route points/);
		expect(() => run('<GPX><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></GPX>')).toThrow(
			/root element/
		);
	});
});
