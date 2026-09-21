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

/**
 * AllTrails' "indexed" series (`indexedElevationData`, `indexedTimeData`): the same varint and
 * zig-zag coding as a polyline, but as delta-coded pairs of (pointIndex × 100, value). Returns
 * pointIndex → value. Plain arithmetic, not 32-bit operators: time values outgrow an int32.
 */
export function decodeIndexed(encoded: string): Map<number, number> {
	const out = new Map<number, number>();
	let at = 0;
	const next = (): number | null => {
		let result = 0;
		let scale = 1;
		for (;;) {
			if (at >= encoded.length) return null;
			const byte = encoded.charCodeAt(at++) - 63;
			if (byte < 0 || byte > 63) return null;
			result += (byte % 0x20) * scale;
			scale *= 0x20;
			if (byte < 0x20) break;
		}
		return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
	};
	let index = 0;
	let value = 0;
	while (at < encoded.length) {
		const dIndex = next();
		const dValue = next();
		if (dIndex === null || dValue === null) break;
		index += dIndex;
		value += dValue;
		out.set(Math.round(index / 100), value);
	}
	return out;
}
