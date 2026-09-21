/**
 * BUILD stage: permission hygiene of BOTH production builds (PRD §17), plus the store zips.
 * Run after `wxt build`, `wxt build -b firefox`, and the two `wxt zip` commands.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const OUTPUT = resolve('.output');
const BUILDS = [
	{ browser: 'chrome', dir: 'chrome-mv3' },
	{ browser: 'firefox', dir: 'firefox-mv3' }
] as const;

const FORBIDDEN_PERMISSIONS = ['cookies', 'tabs', 'power', 'webRequest', 'webRequestBlocking'];
const HOST_PATTERN = /^(\*|https?|wss?|ftp|file):\/\/|^<all_urls>$/;

function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
	else if (value && typeof value === 'object')
		Object.values(value).forEach((item) => collectStrings(item, out));
	return out;
}

describe.each(BUILDS)('$browser build manifest', ({ browser, dir }) => {
	const path = join(OUTPUT, dir, 'manifest.json');
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

	it('ships its icons: every size is in the manifest and is a real PNG in the build', () => {
		expect(Object.keys(manifest.icons ?? {}).sort()).toEqual(['128', '16', '32', '48', '96']);
		for (const [size, file] of Object.entries<string>(manifest.icons)) {
			const bytes = readFileSync(join(OUTPUT, dir, file));
			expect(bytes.subarray(1, 4).toString(), file).toBe('PNG');
			// IHDR width, big-endian, at byte 16.
			expect(bytes.readUInt32BE(16), file).toBe(Number(size));
		}
	});

	it('is Manifest V3', () => {
		expect(manifest.manifest_version).toBe(3);
	});

	it('requests exactly activeTab, scripting, downloads, unlimitedStorage', () => {
		expect([...manifest.permissions].sort()).toEqual(
			['activeTab', 'downloads', 'scripting', 'unlimitedStorage'].sort()
		);
	});

	it('has host permissions ONLY under optional', () => {
		expect(manifest.host_permissions ?? []).toEqual([]);
		expect(manifest.permissions.filter((p: string) => HOST_PATTERN.test(p))).toEqual([]);
		expect(
			(manifest.optional_permissions ?? []).filter((p: string) => HOST_PATTERN.test(p))
		).toEqual([]);
		expect(manifest.optional_host_permissions.length).toBeGreaterThan(0);
		for (const pattern of manifest.optional_host_permissions) {
			expect(pattern).toMatch(
				/^https:\/\/[a-z0-9.-]+\.(gaiagps\.com|gaiagps\.xyz|alltrails\.com)\/\*$/
			);
		}
		expect(manifest.optional_host_permissions).toContain('https://www.gaiagps.com/*');
		// Gaia's photo host, where the site's photo URLs redirect to.
		expect(manifest.optional_host_permissions).toContain('https://photos.gaiagps.xyz/*');
		expect(manifest.optional_host_permissions).toContain('https://www.alltrails.com/*');
	});

	it('declares no content scripts', () => {
		expect(manifest).not.toHaveProperty('content_scripts');
	});

	it('never mentions cookies, tabs, power, webRequest or <all_urls>', () => {
		const requested = [
			...(manifest.permissions ?? []),
			...(manifest.optional_permissions ?? []),
			...(manifest.host_permissions ?? []),
			...(manifest.optional_host_permissions ?? [])
		];
		for (const forbidden of FORBIDDEN_PERMISSIONS) expect(requested).not.toContain(forbidden);
		const strings = collectStrings(manifest);
		expect(strings).not.toContain('<all_urls>');
		expect(strings.filter((value) => /^\*:\/\/|\/\/\*\//.test(value))).toEqual([]);
	});

	it('exposes nothing to web pages and talks to no MapLiberator infrastructure', () => {
		expect(manifest).not.toHaveProperty('web_accessible_resources');
		expect(manifest).not.toHaveProperty('externally_connectable');
		const bundle = readdirSync(join(OUTPUT, dir), { recursive: true })
			.map(String)
			.filter((name) => name.endsWith('.js'))
			.map((name) => readFileSync(join(OUTPUT, dir, name), 'utf8'))
			.join('\n');
		// The only MapLiberator URL in the bundle is the spec link a user may click.
		const ours = bundle.match(/https?:\/\/[a-z0-9.-]*mapliberator\.com[^"'`\s)]*/g) ?? [];
		expect([...new Set(ours)]).toEqual(['https://mapliberator.com/spec/']);
		// No fake-source hosts leak into production builds.
		expect(bundle.includes('.localhost')).toBe(false);
	});

	it('ships the background opener, popup, export page, executor and worker', () => {
		for (const file of ['popup.html', 'export.html', 'source-executor.js', 'exporter-worker.js']) {
			expect(existsSync(join(OUTPUT, dir, file)), file).toBe(true);
		}
		if (browser === 'chrome') expect(manifest.background.service_worker).toBe('background.js');
		else expect(manifest.background.scripts).toEqual(['background.js']);
		expect(manifest.action.default_popup).toBe('popup.html');
	});

	it('produced a store zip', () => {
		const zip = join(OUTPUT, `mapliberator-${manifest.version}-${browser}.zip`);
		expect(existsSync(zip), zip).toBe(true);
		expect(statSync(zip).size).toBeGreaterThan(10_000);
	});
});

describe('firefox specifics', () => {
	const manifest = JSON.parse(readFileSync(join(OUTPUT, 'firefox-mv3', 'manifest.json'), 'utf8'));

	it('pins an add-on ID, a minimum version, and declares no data collection', () => {
		const gecko = manifest.browser_specific_settings.gecko;
		expect(gecko.id).toBe('mapliberator@mapliberator.com');
		expect(Number.parseInt(gecko.strict_min_version, 10)).toBeGreaterThanOrEqual(128);
		expect(gecko.data_collection_permissions).toEqual({ required: ['none'] });
	});

	it('produced the sources zip Mozilla review asks for', () => {
		const sources = readdirSync(OUTPUT).filter((name) => name.endsWith('-sources.zip'));
		expect(sources).toHaveLength(1);
	});
});
