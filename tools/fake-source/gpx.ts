/** Deterministic GPX 1.1 writer for the "native export" endpoints. */
import { isoUtc, type Pt } from './dataset.ts';

export function xmlEscape(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export interface GpxWaypoint {
	lat: number;
	lon: number;
	name: string;
	desc?: string;
}

export interface GpxOptions {
	creator: string;
	/** Platform extension namespace. */
	ns: { prefix: string; uri: string };
	kind: 'trk' | 'rte';
	name: string;
	desc?: string;
	/** Epoch seconds for <metadata><time>. */
	time: number;
	author?: string;
	/** Rendered as <prefix:key>value</prefix:key> inside <extensions>. */
	extensions: [key: string, value: string][];
	segments: Pt[][];
	waypoints?: GpxWaypoint[];
	digits: 5 | 6;
}

export function buildGpx(o: GpxOptions): Buffer {
	const L: string[] = [];
	const coord = (p: { lat: number; lon: number }): string =>
		`lat="${p.lat.toFixed(o.digits)}" lon="${p.lon.toFixed(o.digits)}"`;
	const point = (tag: string, p: Pt, indent: string): void => {
		if (p.ele === null && p.time === null) {
			L.push(`${indent}<${tag} ${coord(p)}/>`);
			return;
		}
		L.push(`${indent}<${tag} ${coord(p)}>`);
		if (p.ele !== null) L.push(`${indent}\t<ele>${p.ele.toFixed(1)}</ele>`);
		if (p.time !== null) L.push(`${indent}\t<time>${isoUtc(p.time)}</time>`);
		L.push(`${indent}</${tag}>`);
	};

	L.push('<?xml version="1.0" encoding="UTF-8"?>');
	L.push(
		`<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:${o.ns.prefix}="${o.ns.uri}" ` +
			'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
			'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" ' +
			`version="1.1" creator="${xmlEscape(o.creator)}">`
	);
	L.push('\t<metadata>');
	L.push(`\t\t<name>${xmlEscape(o.name)}</name>`);
	if (o.author !== undefined) {
		L.push(`\t\t<author><name>${xmlEscape(o.author)}</name></author>`);
	}
	L.push(`\t\t<time>${isoUtc(o.time)}</time>`);
	L.push('\t</metadata>');
	for (const w of o.waypoints ?? []) {
		L.push(`\t<wpt ${coord(w)}>`);
		L.push(`\t\t<name>${xmlEscape(w.name)}</name>`);
		if (w.desc) L.push(`\t\t<desc>${xmlEscape(w.desc)}</desc>`);
		L.push('\t</wpt>');
	}
	L.push(`\t<${o.kind}>`);
	L.push(`\t\t<name>${xmlEscape(o.name)}</name>`);
	if (o.desc) L.push(`\t\t<desc>${xmlEscape(o.desc)}</desc>`);
	if (o.extensions.length > 0) {
		L.push('\t\t<extensions>');
		for (const [key, value] of o.extensions) {
			L.push(`\t\t\t<${o.ns.prefix}:${key}>${xmlEscape(value)}</${o.ns.prefix}:${key}>`);
		}
		L.push('\t\t</extensions>');
	}
	if (o.kind === 'trk') {
		for (const seg of o.segments) {
			L.push('\t\t<trkseg>');
			for (const p of seg) point('trkpt', p, '\t\t\t');
			L.push('\t\t</trkseg>');
		}
	} else {
		for (const seg of o.segments) for (const p of seg) point('rtept', p, '\t\t');
	}
	L.push(`\t</${o.kind}>`);
	L.push('</gpx>');
	L.push('');
	return Buffer.from(L.join('\n'), 'utf8');
}
