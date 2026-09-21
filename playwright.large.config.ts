import { defineConfig } from '@playwright/test';

/** verify:large — ≥ 5 GB synthetic exports. Slow; not part of `npm run verify`. */
export default defineConfig({
	testDir: './e2e',
	testMatch: /large\.spec\.ts/,
	workers: 1,
	forbidOnly: true,
	retries: 0,
	timeout: 60 * 60_000,
	reporter: [['list']],
	outputDir: '.e2e-tmp/results-large'
});
