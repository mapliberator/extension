/**
 * Playwright fixtures: the e2e build of the extension loaded into Chromium, tools/fake-source
 * seeded with a known dataset, and a recorder for every network request the browser makes.
 */
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startFakeSource, type FakeSource, type Platform } from '../tools/fake-source/index.ts';
import { FAKE_SOURCE_PORT } from '../src/adapters/hosts.ts';

export const EXTENSION_DIR = resolve('.output/chrome-mv3-e2e');
const TMP_ROOT = resolve('.e2e-tmp');

export const SOURCE_LABEL: Record<Platform, string> = {
	gaiagps: 'Gaia GPS',
	alltrails: 'AllTrails'
};

export interface ExtensionFixtures {
	fake: FakeSource;
	context: BrowserContext;
	extensionId: string;
	/** URLs of every request made by anything in the browser. */
	requests: string[];
	downloadsDir: string;
	/** Browser-level stubs. Default: no File System Access API, so the OpfsSink path runs. */
	initScript: string;
}

export const test = base.extend<
	ExtensionFixtures & { datasetOption: Parameters<typeof startFakeSource>[0] }
>({
	datasetOption: [{ port: FAKE_SOURCE_PORT, dataset: 'small' }, { option: true }],

	initScript: [
		// Feature detection must then choose the OPFS sink, exactly as on Firefox.
		'delete window.showSaveFilePicker;',
		{ option: true }
	],

	fake: async ({ datasetOption }, use) => {
		const fake = await startFakeSource(datasetOption);
		await use(fake);
		await fake.close();
	},

	downloadsDir: async ({}, use) => {
		mkdirSync(TMP_ROOT, { recursive: true });
		const dir = mkdtempSync(join(TMP_ROOT, 'downloads-'));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},

	requests: async ({}, use) => {
		await use([]);
	},

	context: async ({ fake, downloadsDir, requests, initScript }, use) => {
		if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
			throw new Error('e2e build missing: run `npm run build:e2e` first');
		}
		const profile = mkdtempSync(join(TMP_ROOT, 'profile-'));
		const context = await chromium.launchPersistentContext(profile, {
			channel: 'chromium',
			headless: true,
			acceptDownloads: true,
			downloadsPath: downloadsDir,
			args: [
				`--disable-extensions-except=${EXTENSION_DIR}`,
				`--load-extension=${EXTENSION_DIR}`,
				'--enable-precise-memory-info'
			]
		});
		context.on('request', (request) => requests.push(request.url()));
		await context.addInitScript(initScript);
		await context.addCookies([fake.sessionCookie('gaiagps'), fake.sessionCookie('alltrails')]);
		await use(context);
		await context.close();
		rmSync(profile, { recursive: true, force: true });
	},

	extensionId: async ({ context }, use) => {
		const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
		await use(new URL(worker.url()).host);
	}
});

export { expect };

/** The real entry flow: popup → background → export page. */
export async function openExportPage(
	context: BrowserContext,
	extensionId: string,
	platform: Platform
): Promise<Page> {
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/popup.html`);
	const opened = context.waitForEvent('page', (page) => page.url().includes('/export.html'));
	// Opened as a plain tab, the popup closes itself after the click.
	await popup.getByTestId(`source-${platform}`).click();
	const page = await opened;
	await page.waitForLoadState('domcontentloaded');
	expect(new URL(page.url()).searchParams.get('source')).toBe(platform);
	return page;
}

/** Permission → session → account, up to the selection screen. */
export async function preflight(page: Page, displayName: string): Promise<void> {
	await page.getByTestId('grant-access').click();
	await expect(page.getByTestId('account-name')).toContainText(displayName);
	await expect(page.getByTestId('selection')).toBeVisible();
}

export function sourceTabs(context: BrowserContext, fake: FakeSource, platform: Platform): Page[] {
	return context.pages().filter((page) => page.url().startsWith(fake.origin(platform)));
}

/** Files the browser finished downloading (Playwright names them by GUID). */
export function downloadedFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => !name.endsWith('.crdownload'))
		.map((name) => join(dir, name))
		.filter((path) => statSync(path).isFile());
}

export async function waitForArchive(page: Page, dir: string): Promise<string> {
	await expect(page.getByTestId('done')).toBeVisible({ timeout: 100_000 });
	const files = downloadedFiles(dir);
	expect(files, 'exactly one downloaded archive').toHaveLength(1);
	return files[0]!;
}

export async function opfsExports(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		try {
			const dir = await root.getDirectoryHandle('exports');
			const names: string[] = [];
			for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
				names.push(name);
			}
			return names;
		} catch {
			return [];
		}
	});
}

/** Invariant: the browser talked to fake-source hosts and nothing else. */
export function assertOnlyFakeSourceHosts(requests: string[], fake: FakeSource): void {
	const allowed = new Set(
		(['gaiagps', 'alltrails'] as const).flatMap((platform) => [
			new URL(fake.origin(platform)).host,
			new URL(fake.assetOrigin(platform)).host
		])
	);
	const network = requests.filter((url) => /^(https?|wss?):/.test(url));
	expect(network.length).toBeGreaterThan(0);
	const foreign = network.filter((url) => !allowed.has(new URL(url).host));
	expect(foreign, 'requests to hosts other than fake-source').toEqual([]);
}

import { SENTINELS, trailCoordinatesP5 } from '../tools/fake-source/index.ts';

export function allSentinels(platform: Platform): string[] {
	return [
		SENTINELS.sessionCookie[platform],
		SENTINELS.csrfToken,
		SENTINELS.photoSignature,
		SENTINELS.appKey,
		SENTINELS.email,
		SENTINELS.otherUserName,
		SENTINELS.otherUserEmail,
		SENTINELS.otherUserDescription,
		SENTINELS.trailDescription,
		SENTINELS.trailPolyline,
		...SENTINELS.trailCoordinates,
		...trailCoordinatesP5
	];
}

/** Adapter limits, restated here on purpose: the test must not read them from the code under test. */
export const LIMITS: Record<
	Platform,
	{ apiConcurrency: number; assetConcurrency: number; floorMs: number }
> = {
	gaiagps: { apiConcurrency: 2, assetConcurrency: 4, floorMs: 150 },
	alltrails: { apiConcurrency: 1, assetConcurrency: 2, floorMs: 250 }
};

/** Invariant: peak concurrency ≤ adapter limit, inter-request gap ≥ pacing floor (server-measured). */
export function assertPatientPacing(fake: FakeSource, platform: Platform): void {
	const stats = fake.stats(platform);
	const limits = LIMITS[platform];
	expect(stats.apiRequests).toBeGreaterThan(10);
	expect(stats.peakApiConcurrency).toBeLessThanOrEqual(limits.apiConcurrency);
	expect(stats.peakAssetConcurrency).toBeLessThanOrEqual(limits.assetConcurrency);
	const api = fake
		.log()
		.filter((entry) => entry.platform === platform && entry.lane === 'api')
		.sort((a, b) => a.start - b.start);
	const tooClose = api
		.slice(1)
		.map((entry, index) => ({ gap: entry.start - api[index]!.start, previous: api[index]!, entry }))
		.filter(({ gap }) => gap < limits.floorMs)
		.map(
			({ gap, previous, entry }) =>
				`${gap.toFixed(1)}ms: ${previous.path} [${previous.status}] → ${entry.path} [${entry.status}]`
		);
	expect(tooClose, 'API requests closer together than the pacing floor').toEqual([]);
	expect(stats.minApiGapMs).toBeGreaterThanOrEqual(limits.floorMs);
}
