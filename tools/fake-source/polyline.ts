/** Google encoded polyline algorithm. Points are [lat, lon]. */

function encodeSigned(value: number): string {
	// Left-shift, invert if negative. Use arithmetic (not 32-bit ops) until the value is known small.
	let v = value < 0 ? -value * 2 - 1 : value * 2;
	let out = '';
	while (v >= 0x20) {
		out += String.fromCharCode(((v % 0x20) | 0x20) + 63);
		v = Math.floor(v / 0x20);
	}
	out += String.fromCharCode(v + 63);
	return out;
}

export function encodePolyline(
	points: readonly (readonly [number, number])[],
	precision = 5
): string {
	const factor = 10 ** precision;
	let prevLat = 0;
	let prevLon = 0;
	let out = '';
	for (const [lat, lon] of points) {
		const iLat = Math.round(lat * factor);
		const iLon = Math.round(lon * factor);
		out += encodeSigned(iLat - prevLat) + encodeSigned(iLon - prevLon);
		prevLat = iLat;
		prevLon = iLon;
	}
	return out;
}

export function decodePolyline(encoded: string, precision = 5): [number, number][] {
	const factor = 10 ** precision;
	const out: [number, number][] = [];
	let index = 0;
	let lat = 0;
	let lon = 0;
	const next = (): number => {
		let result = 0;
		let mult = 1;
		for (;;) {
			if (index >= encoded.length) throw new Error('truncated polyline');
			const b = encoded.charCodeAt(index++) - 63;
			result += (b & 0x1f) * mult;
			mult *= 0x20;
			if (b < 0x20) break;
		}
		return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
	};
	while (index < encoded.length) {
		lat += next();
		lon += next();
		out.push([lat / factor, lon / factor]);
	}
	return out;
}
