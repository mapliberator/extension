import { describe, expect, it } from 'vitest';
import {
	areaFeature,
	FeatureCollectionSerializer,
	isValidAreaGeometry,
	isValidPosition,
	normalizeRing,
	ringSignedArea,
	waypointFeature
} from '../src/archive/geojson.ts';
import type { AreaRecord, Position, WaypointRecord } from '../src/shared/models.ts';
import { AreaCollectionSchema, WaypointCollectionSchema } from '../src/shared/schemas.ts';

const SOURCE = { platform: 'gaiagps', id: 'w1', url: 'https://example.test/w1' };
const base = {
	name: 'Camp & water cache',
	description: null,
	createdAt: '2024-06-02T14:11:09Z',
	updatedAt: null,
	visibility: 'private' as const,
	tags: ['water'],
	source: { id: 'w1', url: null, raw: undefined }
};

const waypoint: WaypointRecord = {
	kind: 'waypoint',
	...base,
	position: [-118.29228812345, 36.57858112345, 2447.918],
	icon: 'campsite'
};

// Clockwise square, not closed.
const CW: Position[] = [
	[0, 0],
	[0, 1],
	[1, 1],
	[1, 0]
];
const HOLE_CCW: Position[] = [
	[0.2, 0.2],
	[0.8, 0.2],
	[0.8, 0.8],
	[0.2, 0.8],
	[0.2, 0.2]
];
const area: AreaRecord = {
	kind: 'area',
	...base,
	geometry: { type: 'Polygon', coordinates: [CW, HOLE_CCW] },
	areaSquareMeters: 1234.5
};

describe('waypointFeature', () => {
	it('is an RFC 7946 Point feature whose id is the archive-local ID', () => {
		const feature = waypointFeature('waypoint/000412', waypoint, SOURCE);
		expect(feature).toMatchObject({
			type: 'Feature',
			id: 'waypoint/000412',
			geometry: { type: 'Point', coordinates: [-118.2922881, 36.5785811, 2447.92] },
			properties: { name: 'Camp & water cache', icon: 'campsite', tags: ['water'], source: SOURCE }
		});
	});

	it('omits elevation when there is none', () => {
		const feature = waypointFeature('waypoint/000001', { ...waypoint, position: [1, 2] }, SOURCE);
		expect(feature.geometry.coordinates).toEqual([1, 2]);
	});
});

describe('areaFeature', () => {
	it('closes rings and winds them per RFC 7946 (exterior CCW, holes CW)', () => {
		const feature = areaFeature('area/000001', area, SOURCE);
		const [exterior, hole] = feature.geometry.coordinates as Position[][];
		expect(exterior![0]).toEqual(exterior!.at(-1));
		expect(exterior).toHaveLength(5);
		expect(ringSignedArea(exterior!)).toBeGreaterThan(0);
		expect(ringSignedArea(hole!)).toBeLessThan(0);
		expect(feature.properties.areaSquareMeters).toBe(1234.5);
	});

	it('handles MultiPolygon', () => {
		const feature = areaFeature(
			'area/000002',
			{ ...area, geometry: { type: 'MultiPolygon', coordinates: [[CW], [CW]] } },
			SOURCE
		);
		expect(feature.geometry.type).toBe('MultiPolygon');
		for (const polygon of feature.geometry.coordinates as Position[][][]) {
			expect(ringSignedArea(polygon[0]!)).toBeGreaterThan(0);
		}
	});

	it('leaves an already-correct ring untouched', () => {
		const ccw: Position[] = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0]
		];
		expect(normalizeRing(ccw, true)).toEqual(ccw);
	});
});

describe('geometry validity', () => {
	it('checks positions', () => {
		expect(isValidPosition([0, 0])).toBe(true);
		expect(isValidPosition([200, 0])).toBe(false);
		expect(isValidPosition([0, Number.NaN])).toBe(false);
		expect(isValidPosition([0])).toBe(false);
	});

	it('rejects degenerate polygons', () => {
		expect(isValidAreaGeometry(area.geometry)).toBe(true);
		expect(isValidAreaGeometry({ type: 'Polygon', coordinates: [] })).toBe(false);
		expect(
			isValidAreaGeometry({
				type: 'Polygon',
				coordinates: [
					[
						[0, 0],
						[1, 1]
					]
				]
			})
		).toBe(false);
		expect(
			isValidAreaGeometry({
				type: 'Polygon',
				coordinates: [
					[
						[0, 0],
						[1, 1],
						[500, 2]
					]
				]
			})
		).toBe(false);
	});
});

describe('FeatureCollectionSerializer', () => {
	const collect = (features: unknown[]) => {
		const serializer = new FeatureCollectionSerializer();
		return (
			serializer.open() +
			features.map((feature) => serializer.feature(feature)).join('') +
			serializer.close()
		);
	};

	it('streams a valid, schema-conformant FeatureCollection', () => {
		const text = collect([
			waypointFeature('waypoint/000001', waypoint, SOURCE),
			waypointFeature('waypoint/000002', waypoint, SOURCE)
		]);
		const parsed = JSON.parse(text);
		expect(parsed.features).toHaveLength(2);
		expect(WaypointCollectionSchema.safeParse(parsed).success).toBe(true);
		expect(
			AreaCollectionSchema.safeParse(
				JSON.parse(collect([areaFeature('area/000001', area, SOURCE)]))
			).success
		).toBe(true);
	});

	it('is valid JSON with zero features', () => {
		expect(JSON.parse(collect([]))).toEqual({ type: 'FeatureCollection', features: [] });
	});
});
