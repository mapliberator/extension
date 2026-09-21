import {
	downloadedFiles,
	expect,
	openExportPage,
	opfsExports,
	preflight,
	sourceTabs,
	test
} from './fixtures.ts';

const gaia = 'gaiagps' as const;
const SLOW = [{ platform: gaia, match: '^/api/', action: { kind: 'delay', ms: 400 } } as const];

test('cancel mid-export leaves no OPFS file, no download, and closes the source tab', async ({
	context,
	extensionId,
	fake,
	downloadsDir
}) => {
	const page = await openExportPage(context, extensionId, gaia);
	await preflight(page, fake.expected(gaia).account.displayName);
	fake.setFaults([...SLOW]);
	await page.getByTestId('start-export').click();

	// Mid-export: bytes are already staged in OPFS.
	await expect(page.getByTestId('progress-tracks')).toContainText(/^[2-9] \//, { timeout: 60_000 });
	expect(await opfsExports(page)).toHaveLength(1);
	expect(sourceTabs(context, fake, gaia)).toHaveLength(1);

	await page.getByTestId('cancel').click();
	await expect(page.getByTestId('cancelled')).toBeVisible();

	expect(await opfsExports(page)).toEqual([]);
	expect(downloadedFiles(downloadsDir)).toEqual([]);
	await expect.poll(() => sourceTabs(context, fake, gaia).length).toBe(0);

	// No further source requests after cancelling.
	await page.waitForTimeout(1500);
	const before = fake.log().length;
	await page.waitForTimeout(1500);
	expect(fake.log().length).toBe(before);
});

test('a crash leftover in OPFS exports/ is deleted on the next export-page load', async ({
	context,
	extensionId
}) => {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/export.html`);
	await expect(page.getByTestId('export-page')).toHaveAttribute('data-phase', 'pick-source');

	// Simulate what a crashed run leaves behind.
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle('exports', { create: true });
		const file = await dir.getFileHandle('crashed-run.zip', { create: true });
		const writable = await file.createWritable();
		await writable.write(new Uint8Array(1024 * 1024));
		await writable.close();
	});
	expect(await opfsExports(page)).toEqual(['crashed-run.zip']);

	await page.reload();
	await expect(page.getByTestId('export-page')).toHaveAttribute('data-phase', 'pick-source');
	expect(await opfsExports(page)).toEqual([]);
});

test('a second concurrent export is refused', async ({ context, extensionId, fake }) => {
	const first = await openExportPage(context, extensionId, gaia);
	await preflight(first, fake.expected(gaia).account.displayName);
	fake.setFaults([...SLOW]);
	await first.getByTestId('start-export').click();
	await expect(first.getByTestId('progress')).toBeVisible();

	const second = await openExportPage(context, extensionId, 'alltrails');
	await expect(second.getByTestId('locked-out')).toBeVisible();
	await expect(second.getByTestId('grant-access')).toHaveCount(0);
	await expect(second.getByTestId('start-export')).toHaveCount(0);
	expect(sourceTabs(context, fake, 'alltrails')).toEqual([]);

	// The running export is untouched — and its staged file survived the second page's load.
	await expect(first.getByTestId('progress')).toBeVisible();
	expect(await opfsExports(first)).toHaveLength(1);
	await first.getByTestId('cancel').click();
	await expect(first.getByTestId('cancelled')).toBeVisible();
});
