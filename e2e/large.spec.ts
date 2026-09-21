/**
 * verify:large — a synthetic ≥ 5 GiB photo-heavy account through both sinks (goal.md).
 * Asserts a valid Zip64 archive, photos stored uncompressed, and flat memory: the peak JS heap
 * of the export page plus its worker stays below 512 MB however large the archive gets.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { rmSync, statSync } from 'node:fs';
import { validateArchive } from '../tools/pma-validate/validate.ts';
import { FAKE_SOURCE_PORT } from '../src/adapters/hosts.ts';
import {
	downloadedFiles,
	expect,
	openExportPage,
	opfsExports,
	preflight,
	test,
	waitForArchive
} from './fixtures.ts';

const GIB = 1024 ** 3;
const PHOTOS = 1100;
const PHOTO_BYTES = 5_000_000;
const HEAP_LIMIT = 512 * 1024 * 1024;
const gaia = 'gaiagps' as const;

test.use({
	datasetOption: {
		port: FAKE_SOURCE_PORT,
		dataset: { kind: 'large', photos: PHOTOS, photoBytes: PHOTO_BYTES }
	}
});

interface HeapUsage {
	usedSize: number;
	backingStorageSize: number;
}

/**
 * Samples the V8 heap of the export page and of its worker over CDP until stopped
 * (`performance.memory` does not exist in workers). `usedSize` is the JS heap;
 * `backingStorageSize` — ArrayBuffer memory — is tracked too, since that is where a leak of
 * photo bytes would show up.
 */
async function sampleHeap(context: BrowserContext, page: Page) {
	const peak = {
		page: 0,
		worker: 0,
		combined: 0,
		combinedWithBuffers: 0,
		samples: 0,
		workerSamples: 0
	};
	const cdp = await context.newCDPSession(page);
	const workers = new Set<string>();
	const pending = new Map<number, (usage: HeapUsage | null) => void>();
	let nextId = 1;

	cdp.on('Target.attachedToTarget', (event) => {
		if (event.targetInfo.type === 'worker') workers.add(event.sessionId);
	});
	cdp.on('Target.detachedFromTarget', (event) => workers.delete(event.sessionId));
	cdp.on('Target.receivedMessageFromTarget', (event) => {
		const message = JSON.parse(event.message) as { id?: number; result?: HeapUsage };
		if (message.id === undefined) return;
		pending.get(message.id)?.(message.result ?? null);
		pending.delete(message.id);
	});
	await cdp.send('Target.setAutoAttach', {
		autoAttach: true,
		waitForDebuggerOnStart: false,
		flatten: false
	});

	const workerHeap = (sessionId: string) =>
		new Promise<HeapUsage | null>((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			setTimeout(() => pending.delete(id) && resolve(null), 5000);
			cdp
				.send('Target.sendMessageToTarget', {
					sessionId,
					message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' })
				})
				.catch(() => resolve(null));
		});

	let stopped = false;
	const loop = (async () => {
		while (!stopped) {
			try {
				const pageHeap = (await cdp.send('Runtime.getHeapUsage')) as HeapUsage;
				const workerHeaps = (await Promise.all([...workers].map(workerHeap))).filter(
					(usage): usage is HeapUsage => usage !== null
				);
				const sum = (pick: (usage: HeapUsage) => number) =>
					workerHeaps.reduce((total, usage) => total + pick(usage), 0);
				const workerUsed = sum((usage) => usage.usedSize);
				peak.page = Math.max(peak.page, pageHeap.usedSize);
				peak.worker = Math.max(peak.worker, workerUsed);
				peak.combined = Math.max(peak.combined, pageHeap.usedSize + workerUsed);
				peak.combinedWithBuffers = Math.max(
					peak.combinedWithBuffers,
					pageHeap.usedSize +
						pageHeap.backingStorageSize +
						workerUsed +
						sum((usage) => usage.backingStorageSize)
				);
				peak.samples++;
				if (workerHeaps.length > 0) peak.workerSamples++;
			} catch (error) {
				if (!stopped) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	})();
	return {
		peak,
		async stop() {
			stopped = true;
			await loop;
			await cdp.detach().catch(() => {});
		}
	};
}

type HeapPeak = Awaited<ReturnType<typeof sampleHeap>>['peak'];

async function assertLargeArchive(archivePath: string, peak: HeapPeak) {
	const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
	console.log(
		`archive ${(statSync(archivePath).size / GIB).toFixed(2)} GiB · peak heap page ${mb(peak.page)}, ` +
			`worker ${mb(peak.worker)}, combined ${mb(peak.combined)}, with ArrayBuffers ` +
			`${mb(peak.combinedWithBuffers)} (${peak.samples} samples)`
	);
	expect(statSync(archivePath).size).toBeGreaterThanOrEqual(5 * GIB);

	const validation = await validateArchive(archivePath);
	expect(validation.errors).toEqual([]);
	expect(validation.valid).toBe(true);
	expect(validation.zip64).toBe(true);
	expect(validation.counts.photos).toBe(PHOTOS);
	expect((validation.manifest as { status: string }).status).toBe('complete');
	expect(validation.entries.at(-1)!.name).toBe('manifest.json');

	// Photos are stored, never recompressed.
	const photos = validation.entries.filter(
		(entry) => entry.name.startsWith('photos/') && !entry.name.endsWith('.json')
	);
	expect(photos).toHaveLength(PHOTOS);
	for (const photo of photos) {
		expect(photo.compressionMethod).toBe(0);
		expect(photo.compressedSize).toBe(PHOTO_BYTES);
		expect(photo.uncompressedSize).toBe(PHOTO_BYTES);
	}

	// Memory stayed flat: sampled throughout, worker included.
	expect(peak.samples).toBeGreaterThan(10);
	expect(peak.workerSamples).toBeGreaterThan(10);
	expect(peak.combined).toBeLessThan(HEAP_LIMIT);
	expect(peak.combinedWithBuffers).toBeLessThan(HEAP_LIMIT);
}

test('large: ≥ 5 GiB through OpfsSink → download', async ({
	context,
	extensionId,
	fake,
	downloadsDir
}) => {
	const page = await openExportPage(context, extensionId, gaia);
	await preflight(page, fake.expected(gaia).account.displayName);
	const heap = await sampleHeap(context, page);
	await page.getByTestId('start-export').click();
	await expect(page.getByTestId('done')).toBeVisible({ timeout: 50 * 60_000 });
	await heap.stop();

	const archivePath = await waitForArchive(page, downloadsDir);
	expect(await opfsExports(page)).toEqual([]);
	await assertLargeArchive(archivePath, heap.peak);
	rmSync(archivePath, { force: true });
});

test.describe('DirectFileSink', () => {
	// The native save-file picker cannot be driven by automation, so it is stubbed to hand out a
	// real FileSystemFileHandle (in OPFS). Everything downstream — createWritable(), the swap
	// file, close() — is the genuine DirectFileSink path.
	test.use({
		initScript: `window.showSaveFilePicker = async () => {
			const root = await navigator.storage.getDirectory();
			return root.getFileHandle('direct-out.zip', { create: true });
		};`
	});

	test('large: ≥ 5 GiB through DirectFileSink (picker stubbed)', async ({
		context,
		extensionId,
		fake,
		downloadsDir
	}) => {
		const page = await openExportPage(context, extensionId, gaia);
		await preflight(page, fake.expected(gaia).account.displayName);
		const heap = await sampleHeap(context, page);
		await page.getByTestId('start-export').click();
		await expect(page.getByTestId('done')).toBeVisible({ timeout: 50 * 60_000 });
		await heap.stop();

		// The direct sink never stages in exports/ and never uses the downloads API.
		expect(await opfsExports(page)).toEqual([]);
		expect(downloadedFiles(downloadsDir)).toEqual([]);

		// Test harness only: copy the picked file out of OPFS so Node can validate it.
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const file = await (await root.getFileHandle('direct-out.zip')).getFile();
			const url = URL.createObjectURL(file);
			const id = await chrome.downloads.download({ url, filename: 'direct-out.zip' });
			await new Promise<void>((resolve, reject) => {
				chrome.downloads.onChanged.addListener((delta) => {
					if (delta.id !== id || !delta.state) return;
					if (delta.state.current === 'complete') resolve();
					if (delta.state.current === 'interrupted') reject(new Error('copy-out interrupted'));
				});
			});
			URL.revokeObjectURL(url);
			await root.removeEntry('direct-out.zip');
		});
		const [archivePath] = downloadedFiles(downloadsDir);
		expect(archivePath).toBeTruthy();
		await assertLargeArchive(archivePath!, heap.peak);
		rmSync(archivePath!, { force: true });
	});
});
