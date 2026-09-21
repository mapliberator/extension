/**
 * GPX 1.1 serializer for the JSON fallback path. Dense geometry is always written as
 * `<trk>`/`<trkseg>` — many consumers mangle or truncate dense `<rte>` (PRD §6.3).
 */
import type { TrackPoint } from '../shared/models';

export interface GpxMeta {
	name: string;
	description: string | null;
	/** RFC 3339 UTC */
	time: string | null;
	/** GPX <type>, e.g. the activity */
	type: string | null;
	creator: string;
}

// Characters that are not allowed in XML 1.0 documents at all.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(text: string): string {
	return text
		.replace(INVALID_XML_CHARS, '')
		.replace(LONE_SURROGATES, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatNumber(value: number, decimals: number): string {
	return String(Number(value.toFixed(decimals)));
}

export function countPoints(segments: TrackPoint[][]): number {
	return segments.reduce((sum, segment) => sum + segment.length, 0);
}

const POINTS_PER_CHUNK = 500;

/** Yields the document in bounded string chunks so large tracks never build one giant string. */
export function* serializeGpx(meta: GpxMeta, segments: TrackPoint[][]): Generator<string> {
	let head = '<?xml version="1.0" encoding="UTF-8"?>\n';
	head += `<gpx version="1.1" creator="${escapeXml(meta.creator)}" xmlns="http://www.topografix.com/GPX/1/1"`;
	head += ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
	head +=
		' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n';
	head += '\t<metadata>\n';
	head += `\t\t<name>${escapeXml(meta.name)}</name>\n`;
	if (meta.description) head += `\t\t<desc>${escapeXml(meta.description)}</desc>\n`;
	if (meta.time) head += `\t\t<time>${escapeXml(meta.time)}</time>\n`;
	head += '\t</metadata>\n';
	head += '\t<trk>\n';
	head += `\t\t<name>${escapeXml(meta.name)}</name>\n`;
	if (meta.description) head += `\t\t<desc>${escapeXml(meta.description)}</desc>\n`;
	if (meta.type) head += `\t\t<type>${escapeXml(meta.type)}</type>\n`;
	yield head;

	for (const segment of segments) {
		if (segment.length === 0) continue;
		yield '\t\t<trkseg>\n';
		let chunk = '';
		let inChunk = 0;
		for (const point of segment) {
			chunk += `\t\t\t<trkpt lat="${formatNumber(point.lat, 7)}" lon="${formatNumber(point.lon, 7)}">`;
			if (point.ele !== null && point.ele !== undefined && Number.isFinite(point.ele)) {
				chunk += `<ele>${formatNumber(point.ele, 2)}</ele>`;
			}
			if (point.time) chunk += `<time>${escapeXml(point.time)}</time>`;
			chunk += '</trkpt>\n';
			if (++inChunk >= POINTS_PER_CHUNK) {
				yield chunk;
				chunk = '';
				inChunk = 0;
			}
		}
		if (chunk) yield chunk;
		yield '\t\t</trkseg>\n';
	}
	yield '\t</trk>\n</gpx>\n';
}

export function isValidPoint(point: TrackPoint): boolean {
	return (
		Number.isFinite(point.lat) &&
		Number.isFinite(point.lon) &&
		Math.abs(point.lat) <= 90 &&
		Math.abs(point.lon) <= 180
	);
}
