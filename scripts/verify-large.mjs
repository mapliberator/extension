#!/usr/bin/env node
/** `npm run verify:large` — slow; not part of `verify`. Needs ~20 GB of free disk. */
import { spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const [label, args] of [
	['install Chromium for Playwright', ['playwright', 'install', 'chromium']],
	['e2e build (fake-source hosts)', ['wxt', 'build', '--mode', 'e2e']],
	['large exports', ['playwright', 'test', '--config', 'playwright.large.config.ts']]
]) {
	console.log(`\n▸ ${label}`);
	const result = spawnSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });
	if (result.status !== 0) {
		console.error(`\n✖ verify:large failed at: ${label}`);
		process.exit(result.status ?? 1);
	}
}
console.log('\n✔ verify:large passed');
