// Renders the store images next to this file from the repository's logo.png: a transparent copy of
// the logo, the 128×128 store icon and the promo tiles (tile.html). Also writes the extension's own
// icons in public/icons/.
//   node store/render.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const logoPath = join(here, '..', 'logo.png');
const outDir = here;
const browser = await chromium.launch();
const page = await browser.newPage();

// 1. Transparent logo, white removed everywhere, including inside the artwork (pin hole, folds,
// trail). The artwork is flat colours whose darkest channel is under SOLID; everything else is one
// of them mixed with white. Each such pixel takes the colour of the nearest solid pixel within
// REACH, with the alpha that mixes back to what was drawn, so the colours keep full strength.
const logoData = 'data:image/png;base64,' + readFileSync(logoPath).toString('base64');
const transparent = await page.evaluate(async (src) => {
	const SOLID = 72,
		PAPER = 244,
		REACH = 5;
	const img = new Image();
	img.src = src;
	await img.decode();
	const W = img.width,
		H = img.height,
		N = W * H;
	const c = new OffscreenCanvas(W, H);
	const x = c.getContext('2d');
	x.drawImage(img, 0, 0);
	const im = x.getImageData(0, 0, W, H);
	const d = im.data;
	const lo = new Uint8Array(N);
	for (let i = 0; i < N; i++) lo[i] = Math.min(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
	let minX = W,
		minY = H,
		maxX = 0,
		maxY = 0;
	for (let py = 0; py < H; py++) {
		for (let px = 0; px < W; px++) {
			const i = py * W + px;
			if (lo[i] >= SOLID) {
				let nearest = -1,
					best = Infinity;
				for (let dy = -REACH; dy <= REACH; dy++) {
					const y = py + dy;
					if (y < 0 || y >= H) continue;
					for (let dx = -REACH; dx <= REACH; dx++) {
						const x = px + dx;
						const j = y * W + x;
						if (x < 0 || x >= W || lo[j] >= SOLID || dx * dx + dy * dy >= best) continue;
						nearest = j;
						best = dx * dx + dy * dy;
					}
				}
				const alpha = nearest < 0 ? 0 : Math.min(1, (PAPER - lo[i]) / (PAPER - lo[nearest]));
				if (alpha <= 0.02) {
					d[4 * i + 3] = 0;
					continue;
				}
				d[4 * i] = d[4 * nearest];
				d[4 * i + 1] = d[4 * nearest + 1];
				d[4 * i + 2] = d[4 * nearest + 2];
				d[4 * i + 3] = Math.round(alpha * 255);
			}
			minX = Math.min(minX, px);
			maxX = Math.max(maxX, px);
			minY = Math.min(minY, py);
			maxY = Math.max(maxY, py);
		}
	}
	x.putImageData(im, 0, 0);
	// Crop to a square around the artwork.
	const side = Math.max(maxX - minX, maxY - minY) + 1;
	const cx = (minX + maxX) / 2,
		cy = (minY + maxY) / 2;
	const out = new OffscreenCanvas(side, side);
	out
		.getContext('2d')
		.drawImage(
			c,
			Math.round(cx - side / 2),
			Math.round(cy - side / 2),
			side,
			side,
			0,
			0,
			side,
			side
		);
	const blob = await out.convertToBlob({ type: 'image/png' });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return 'data:image/png;base64,' + btoa(bin);
}, logoData);
writeFileSync(
	join(outDir, 'logo-transparent.png'),
	Buffer.from(transparent.split(',')[1], 'base64')
);

// 2. Icons: the artwork at `art` pixels in the middle of a `size` square. Halving steps keep the
// downscale sharp. The store icon wants 16px of padding around 96×96; the toolbar icons in
// public/icons/ fill their square, less a hairline.
function iconPng(size, art) {
	return page.evaluate(
		async ([src, size, art]) => {
			const img = new Image();
			img.src = src;
			await img.decode();
			let cur = img,
				step = img.width;
			while (step / 2 >= art * 2) {
				step = Math.round(step / 2);
				const half = new OffscreenCanvas(step, step);
				const hx = half.getContext('2d');
				hx.imageSmoothingQuality = 'high';
				hx.drawImage(cur, 0, 0, step, step);
				cur = half;
			}
			const c = new OffscreenCanvas(size, size);
			const x = c.getContext('2d');
			x.imageSmoothingQuality = 'high';
			x.drawImage(cur, (size - art) / 2, (size - art) / 2, art, art);
			const bytes = new Uint8Array(
				await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()
			);
			return btoa(String.fromCharCode(...bytes));
		},
		[transparent, size, art]
	);
}
writeFileSync(join(outDir, 'icon-128.png'), Buffer.from(await iconPng(128, 96), 'base64'));
for (const size of [16, 32, 48, 96, 128]) {
	const art = size - 2 * Math.round(size / 64);
	writeFileSync(
		join(here, '..', 'public', 'icons', `${size}.png`),
		Buffer.from(await iconPng(size, art), 'base64')
	);
}

// 3. Promo tiles.
const logoFile = join(outDir, 'logo-transparent.png');
for (const [name, w, h, layout] of [
	['promo-small-440x280.png', 440, 280, 'small'],
	['promo-marquee-1400x560.png', 1400, 560, 'marquee']
]) {
	await page.setViewportSize({ width: w, height: h });
	const url = pathToFileURL(join(here, 'tile.html'));
	url.search = new URLSearchParams({ w, h, layout, logo: pathToFileURL(logoFile).href }).toString();
	await page.goto(url.href);
	await page.evaluate(() => window.ready);
	await page.screenshot({ path: join(outDir, name), omitBackground: false });
}
await browser.close();
console.log(`wrote the store images to ${outDir}`);
