import { defineConfig } from '@playwright/test';

/** E2E: the e2e build of the extension, loaded into Chromium, against tools/fake-source. */
export default defineConfig({
	testDir: './e2e',
	testMatch: /.*\.spec\.ts/,
	testIgnore: /large\.spec\.ts/,
	// One fake-source on a fixed port (it is baked into the e2e build's host list).
	workers: 1,
	fullyParallel: false,
	forbidOnly: true,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 20_000 },
	reporter: [['list']],
	outputDir: '.e2e-tmp/results'
});
