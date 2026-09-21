/** Google encoded polyline → [lat, lon] pairs. AllTrails encodes geometry at precision 5. */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
	const factor = 10 ** precision;
	const points: [number, number][] = [];
	let index = 0;
	let lat = 0;
	let lon = 0;

	const next = (): number | null => {
		let result = 0;
		let shift = 0;
		let byte: number;
		do {
			if (index >= encoded.length) return null;
			byte = encoded.charCodeAt(index++) - 63;
			if (byte < 0 || byte > 63) return null;
			result |= (byte & 0x1f) << shift;
			shift += 5;
		} while (byte >= 0x20);
		return result & 1 ? ~(result >> 1) : result >> 1;
	};

	while (index < encoded.length) {
		const dLat = next();
		const dLon = next();
		if (dLat === null || dLon === null) break;
		lat += dLat;
		lon += dLon;
		points.push([lat / factor, lon / factor]);
	}
	return points;
}
