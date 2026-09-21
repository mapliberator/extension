#!/usr/bin/env node
/**
 * `npm run verify` — every stage must pass; the first failure stops the run (goal.md).
 *
 *   STATIC  tsc (strict) · svelte-check · prettier · Vitest unit suites
 *   BUILD   Chrome + Firefox builds and store zips · web-ext lint · manifest assertions
 *   E2E     Playwright (Chromium, extension loaded) against tools/fake-source
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const started = Date.now();

function stage(title) {
	console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 72 - title.length))}`);
}

function run(label, command, args, env = {}) {
	console.log(`\n▸ ${label}\n  $ ${command} ${args.join(' ')}`);
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		env: { ...process.env, ...env },
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		console.error(`\n✖ verify failed at: ${label}`);
		process.exit(result.status ?? 1);
	}
}

/** "Done" means no skipped, todo, fixme or focused tests anywhere. */
function assertNoSkippedTests() {
	const pattern =
		/\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only|fixme|fails)\b|\bx(?:it|test|describe)\s*\(/;
	const offenders = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(test|spec)\.ts$/.test(name)) {
				readFileSync(path, 'utf8')
					.split('\n')
					.forEach((line, index) => {
						if (pattern.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
					});
			}
		}
	};
	walk('tests');
	walk('e2e');
	console.log('\n▸ no skipped, todo or focused tests');
	if (offenders.length > 0) {
		console.error(offenders.join('\n'));
		console.error('\n✖ verify failed at: skipped/todo tests');
		process.exit(1);
	}
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

stage('STATIC');
assertNoSkippedTests();
run('typecheck extension (tsc --noEmit, strict)', npx, ['tsc', '--noEmit']);
run('typecheck tools, scripts and tests', npx, ['tsc', '--noEmit', '-p', 'tools/tsconfig.json']);
run('typecheck Svelte components', npx, [
	'svelte-check',
	'--tsconfig',
	'./tsconfig.json',
	'--fail-on-warnings'
]);
run('prettier --check .', npx, ['prettier', '--check', '.']);
run('unit suites (Vitest)', npx, ['vitest', 'run']);

stage('BUILD');
rmSync('.output', { recursive: true, force: true });
run('Chrome build + store zip', npx, ['wxt', 'zip']);
run('Firefox build + store zip', npx, ['wxt', 'zip', '-b', 'firefox']);
run('web-ext lint (Firefox build)', npx, [
	'web-ext',
	'lint',
	'--source-dir',
	'.output/firefox-mv3'
]);
run('manifest assertions for both builds', npx, [
	'vitest',
	'run',
	'--config',
	'vitest.build.config.ts'
]);

stage('E2E');
run('install Chromium for Playwright', npx, ['playwright', 'install', 'chromium']);
run('e2e build (fake-source hosts)', npx, ['wxt', 'build', '--mode', 'e2e']);
run('Playwright e2e', npx, ['playwright', 'test']);

console.log(`\n✔ verify passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
