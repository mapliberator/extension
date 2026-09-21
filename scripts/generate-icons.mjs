// Builds the toolbar/store icons from logo.png without any image dependency: drops the white
// backdrop, crops to the artwork and box-filters down to each size.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

// Decodes a non-interlaced 8-bit RGB or RGBA PNG into straight RGBA.
function decode(file) {
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat = [];
	for (let at = 8; at < file.length;) {
		const length = file.readUInt32BE(at);
		const type = file.toString('latin1', at + 4, at + 8);
		const data = file.subarray(at + 8, at + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const [depth, color, , , interlace] = data.subarray(8);
			if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0)
				throw new Error('logo.png must be a non-interlaced 8-bit RGB or RGBA PNG');
			channels = color === 2 ? 3 : 4;
		}
		if (type === 'IDAT') idat.push(data);
		at += length + 12;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rows = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? rows[y * stride + i - channels] : 0;
			const up = y > 0 ? rows[(y - 1) * stride + i] : 0;
			const upLeft = y > 0 && i >= channels ? rows[(y - 1) * stride + i - channels] : 0;
			let predicted = 0;
			if (filter === 1) predicted = left;
			else if (filter === 2) predicted = up;
			else if (filter === 3) predicted = (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
				predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			}
			rows[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predicted) & 0xff;
		}
	}
	const rgba = Buffer.alloc(width * height * 4, 255);
	for (let p = 0; p < width * height; p++)
		rows.copy(rgba, p * 4, p * channels, p * channels + channels);
	return { width, height, rgba };
}

// Clears the near-white backdrop reachable from the border; white inside the artwork stays.
function dropBackdrop({ width, height, rgba }) {
	const isBackdrop = (p) => Math.min(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]) > 215;
	const seen = new Uint8Array(width * height);
	const stack = [];
	const visit = (x, y) => {
		const p = y * width + x;
		if (x < 0 || y < 0 || x >= width || y >= height || seen[p] || !isBackdrop(p)) return;
		seen[p] = 1;
		stack.push(p);
	};
	for (let x = 0; x < width; x++) (visit(x, 0), visit(x, height - 1));
	for (let y = 0; y < height; y++) (visit(0, y), visit(width - 1, y));
	while (stack.length > 0) {
		const p = stack.pop();
		rgba[p * 4 + 3] = 0;
		const [x, y] = [p % width, Math.floor(p / width)];
		(visit(x - 1, y), visit(x + 1, y), visit(x, y - 1), visit(x, y + 1));
	}
}

// The square around the remaining artwork, centred, with a little padding.
function artworkSquare({ width, height, rgba }) {
	let [left, top, right, bottom] = [width, height, 0, 0];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (rgba[(y * width + x) * 4 + 3] === 0) continue;
			[left, top] = [Math.min(left, x), Math.min(top, y)];
			[right, bottom] = [Math.max(right, x + 1), Math.max(bottom, y + 1)];
		}
	}
	const side = Math.max(right - left, bottom - top) * 1.04;
	return { x: (left + right - side) / 2, y: (top + bottom - side) / 2, side };
}

// Box-filters the square down to size x size, averaging premultiplied colour.
function resize({ width, height, rgba }, square, size) {
	const out = Buffer.alloc(size * size * 4);
	const scale = square.side / size;
	for (let oy = 0; oy < size; oy++) {
		for (let ox = 0; ox < size; ox++) {
			let [r, g, b, a, n] = [0, 0, 0, 0, 0];
			const y1 = Math.ceil(square.y + (oy + 1) * scale);
			const x1 = Math.ceil(square.x + (ox + 1) * scale);
			for (let y = Math.floor(square.y + oy * scale); y < y1; y++) {
				for (let x = Math.floor(square.x + ox * scale); x < x1; x++) {
					n++;
					if (x < 0 || y < 0 || x >= width || y >= height) continue;
					const p = (y * width + x) * 4;
					const alpha = rgba[p + 3];
					r += rgba[p] * alpha;
					g += rgba[p + 1] * alpha;
					b += rgba[p + 2] * alpha;
					a += alpha;
				}
			}
			if (a > 0) out.set([r / a, g / a, b / a, a / n].map(Math.round), (oy * size + ox) * 4);
		}
	}
	return out;
}

function encode(size, rgba) {
	const raw = Buffer.alloc((size * 4 + 1) * size);
	for (let y = 0; y < size; y++)
		rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

const logo = decode(readFileSync('logo.png'));
dropBackdrop(logo);
const square = artworkSquare(logo);
mkdirSync('src/public/icon', { recursive: true });
for (const size of [16, 32, 48, 96, 128]) {
	writeFileSync(`src/public/icon/${size}.png`, encode(size, resize(logo, square, size)));
}
