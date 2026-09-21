/**
 * GeoJSON (RFC 7946) serializers for the aggregated waypoint and area collections. Features are
 * produced one at a time and streamed into a single ZIP entry.
 */
import type { AreaRecord, Position, WaypointRecord } from '../shared/models';
import type { AreaFeature, WaypointFeature } from '../shared/schemas';

// A type alias (not an interface) so it stays assignable to the loose archive schemas.
export type FeatureSource = {
	platform: string;
	id: string;
	url: string | null;
	raw?: unknown;
};

function roundPosition(position: Position): Position {
	const lon = Number(position[0].toFixed(7));
	const lat = Number(position[1].toFixed(7));
	const ele = position[2];
	return ele === undefined || !Number.isFinite(ele)
		? [lon, lat]
		: [lon, lat, Number(ele.toFixed(2))];
}

export function isValidPosition(position: readonly number[]): boolean {
	const [lon, lat] = position;
	return (
		typeof lon === 'number' &&
		typeof lat === 'number' &&
		Number.isFinite(lon) &&
		Number.isFinite(lat) &&
		Math.abs(lon) <= 180 &&
		Math.abs(lat) <= 90
	);
}

export function waypointFeature(
	id: string,
	record: WaypointRecord,
	source: FeatureSource
): WaypointFeature {
	return {
		type: 'Feature',
		id,
		geometry: { type: 'Point', coordinates: roundPosition(record.position) },
		properties: {
			name: record.name,
			description: record.description,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			visibility: record.visibility,
			tags: record.tags,
			icon: record.icon,
			source
		}
	};
}

/** Signed area of a ring in coordinate space; positive = counter-clockwise. */
export function ringSignedArea(ring: readonly Position[]): number {
	let sum = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		const a = ring[i]!;
		const b = ring[i + 1]!;
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum / 2;
}

/** Closes the ring and winds it per RFC 7946 §3.1.6 (exterior CCW, holes CW). */
export function normalizeRing(ring: readonly Position[], exterior: boolean): Position[] {
	const out = ring.map(roundPosition);
	const first = out[0];
	const last = out[out.length - 1];
	if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push(first);
	const ccw = ringSignedArea(out) > 0;
	if (ccw !== exterior) out.reverse();
	return out;
}

function normalizePolygon(rings: readonly Position[][]): Position[][] {
	return rings.map((ring, index) => normalizeRing(ring, index === 0));
}

export function areaFeature(id: string, record: AreaRecord, source: FeatureSource): AreaFeature {
	const geometry =
		record.geometry.type === 'Polygon'
			? { type: 'Polygon' as const, coordinates: normalizePolygon(record.geometry.coordinates) }
			: {
					type: 'MultiPolygon' as const,
					coordinates: record.geometry.coordinates.map(normalizePolygon)
				};
	return {
		type: 'Feature',
		id,
		geometry,
		properties: {
			name: record.name,
			description: record.description,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			visibility: record.visibility,
			tags: record.tags,
			areaSquareMeters: record.areaSquareMeters,
			source
		}
	};
}

/** Rings need four positions (closed triangle) to be a polygon at all. */
export function isValidAreaGeometry(geometry: AreaRecord['geometry']): boolean {
	const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
	if (polygons.length === 0) return false;
	return polygons.every(
		(rings) =>
			rings.length > 0 &&
			rings.every((ring) => normalizeRing(ring, true).length >= 4 && ring.every(isValidPosition))
	);
}

/** Incremental writer for `{"type":"FeatureCollection","features":[…]}`. */
export class FeatureCollectionSerializer {
	private count = 0;

	open(): string {
		return '{"type":"FeatureCollection","features":[';
	}

	feature(feature: unknown): string {
		const prefix = this.count++ === 0 ? '\n' : ',\n';
		return prefix + JSON.stringify(feature);
	}

	close(): string {
		return '\n]}\n';
	}
}
