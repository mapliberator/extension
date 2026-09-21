/** Deterministic building blocks shared by both platform datasets. No Date.now(), no Math.random(). */
import { SENTINEL_TRAIL_POINTS } from './sentinels.ts';
import type { DatasetOptions } from './types.ts';

export interface ResolvedDataset {
	kind: 'small' | 'large';
	maxPageSize: number;
	photos: number;
	photoBytes: number;
}

export function resolveDataset(
	input: 'small' | 'large' | DatasetOptions | undefined
): ResolvedDataset {
	const opts: DatasetOptions =
		typeof input === 'string' ? { kind: input } : (input ?? { kind: 'small' });
	if (opts.kind === 'large') {
		return {
			kind: 'large',
			maxPageSize: positiveInt(opts.maxPageSize, 100),
			photos: nonNegativeInt(opts.photos, 1100),
			photoBytes: positiveInt(opts.photoBytes, 5_000_000)
		};
	}
	return { kind: 'small', maxPageSize: positiveInt(opts.maxPageSize, 3), photos: 0, photoBytes: 0 };
}

function positiveInt(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export interface Env {
	origin: string;
	cdnOrigin: string;
}

export function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 2024-06-02T14:11:09Z == 2024-06-02T07:11:09-07:00 */
export const BASE_EPOCH = Date.UTC(2024, 5, 2, 14, 11, 9) / 1000;
export const DAY = 86400;

export function isoWithOffset(epochSeconds: number, offsetMinutes = -420): string {
	const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000).toISOString().slice(0, 19);
	const sign = offsetMinutes < 0 ? '-' : '+';
	const abs = Math.abs(offsetMinutes);
	const hh = String(Math.floor(abs / 60)).padStart(2, '0');
	const mm = String(abs % 60).padStart(2, '0');
	return `${shifted}${sign}${hh}:${mm}`;
}

export function isoUtc(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

export function isoDate(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export interface Pt {
	lat: number;
	lon: number;
	ele: number | null;
	time: number | null;
}

export interface LineSpec {
	seed: string;
	start: [lat: number, lon: number];
	/** Points per segment. */
	segments: number[];
	/** Decimal digits for lat/lon: 6 for the Gaia shape, 5 for the AllTrails (polyline) shape. */
	digits: 5 | 6;
	startTime: number;
	ele?: boolean;
	time?: boolean;
}

function round(value: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

/** Seeded random walk; consecutive points are ~13–25 m and 5–14 s apart. */
export function makeLine(spec: LineSpec): Pt[][] {
	const rng = mulberry32(fnv1a(spec.seed));
	let lat = spec.start[0];
	let lon = spec.start[1];
	let ele = 1200 + rng() * 1500;
	let time = spec.startTime;
	let heading = rng() * Math.PI * 2;
	const out: Pt[][] = [];
	for (const n of spec.segments) {
		const seg: Pt[] = [];
		for (let i = 0; i < n; i++) {
			seg.push({
				lat: round(lat, spec.digits),
				lon: round(lon, spec.digits),
				ele: spec.ele === false ? null : round(ele, 1),
				time: spec.time === false ? null : time
			});
			heading += (rng() - 0.5) * 0.7;
			const step = 0.00012 + rng() * 0.0001;
			lat += Math.cos(heading) * step;
			lon += (Math.sin(heading) * step) / Math.cos((lat * Math.PI) / 180);
			ele += (rng() - 0.45) * 3;
			time += 5 + Math.floor(rng() * 10);
		}
		out.push(seg);
		// A pause between segments: jump ahead a little in space and ten minutes in time.
		lat += 0.0006;
		lon += 0.0004;
		time += 600;
	}
	return out;
}

export interface LineStats {
	distance: number;
	ascent: number;
	duration: number;
}

export function lineStats(segments: Pt[][]): LineStats {
	let distance = 0;
	let ascent = 0;
	let first: number | null = null;
	let last: number | null = null;
	for (const seg of segments) {
		for (let i = 0; i < seg.length; i++) {
			const p = seg[i]!;
			if (p.time !== null) {
				first ??= p.time;
				last = p.time;
			}
			if (i === 0) continue;
			const q = seg[i - 1]!;
			distance += haversine(q, p);
			if (p.ele !== null && q.ele !== null && p.ele > q.ele) ascent += p.ele - q.ele;
		}
	}
	return {
		distance: round(distance, 1),
		ascent: round(ascent, 1),
		duration: first !== null && last !== null ? last - first : 0
	};
}

function haversine(a: Pt, b: Pt): number {
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLon = (b.lon - a.lon) * rad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * 6371008.8 * Math.asin(Math.sqrt(s));
}

/** Platform-owned trails. Geometry always STARTS with the two sentinel points. */
export interface PlatformTrail {
	key: string;
	name: string;
	slug: string;
	/** Representative coordinate [lat, lon] — not part of the geometry, allowed in archives. */
	trailhead: [number, number];
	/** Geometry as [lat, lon], 6 decimals. */
	geometry: [number, number][];
}

function trailGeometry(variant: number): [number, number][] {
	const pts: [number, number][] = SENTINEL_TRAIL_POINTS.map(([lat, lon]) => [lat, lon]);
	const [lat0, lon0] = SENTINEL_TRAIL_POINTS[1]!;
	for (let k = 1; k <= 3 + variant; k++) {
		pts.push([
			round(lat0 + k * (0.00171 + variant * 0.00013), 6),
			round(lon0 + k * (0.00212 - variant * 0.00029), 6)
		]);
	}
	return pts;
}

export const PLATFORM_TRAILS: readonly PlatformTrail[] = [
	{
		key: 'A',
		name: 'Upper Yosemite Falls Trail',
		slug: 'upper-yosemite-falls-trail',
		trailhead: [37.74235, -119.60214],
		geometry: trailGeometry(0)
	},
	{
		key: 'B',
		name: 'Mist Trail to Vernal Fall',
		slug: 'mist-trail-to-vernal-fall',
		trailhead: [37.73264, -119.55801],
		geometry: trailGeometry(1)
	},
	{
		key: 'C',
		name: 'Mirror Lake Loop',
		slug: 'mirror-lake-loop',
		trailhead: [37.73911, -119.57392],
		geometry: trailGeometry(2)
	}
];

export const NAMES = {
	slashes: 'Morning loop / ridge ../summit',
	emoji: '🏔️🥾',
	accents: 'Sentier des Crêtes – Übergang à l’été',
	long:
		'Very long name that keeps going and going to exercise the filename sanitizer limits across ' +
		'ridges, valleys, rivers, meadows, passes and several more words than anyone would type',
	duplicate: 'Evening walk'
};
