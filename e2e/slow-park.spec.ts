import { expect, openExportPage, preflight, test } from './fixtures.ts';

// The parking page of a real site takes a moment to arrive. The bridge must wait for THAT page,
// not for whatever the fresh tab shows first.
test('attaches to the source tab even when its parking page loads slowly', async ({
	context,
	extensionId,
	fake
}) => {
	fake.setFaults([
		{ platform: 'gaiagps', match: '^/robots\\.txt$', action: { kind: 'delay', ms: 2500 } }
	]);
	const page = await openExportPage(context, extensionId, 'gaiagps');
	await preflight(page, fake.expected('gaiagps').account.displayName);
	await expect(page.getByTestId('paused')).toHaveCount(0);
});
