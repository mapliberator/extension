import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtures, FIXTURES } from '../tools/pma-validate/fixtures/build-fixtures.ts';
import { readArchiveTree } from '../tools/pma-validate/reader.ts';
import { unsafeNameReason, validateArchive } from '../tools/pma-validate/validate.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(ROOT, 'tools', 'pma-validate', 'cli.ts');

let dir: string;
let fixtures: Record<string, string>;
const fixture = (name: string): string => {
	const path = fixtures[name];
	if (path === undefined) throw new Error(`no fixture named ${name}`);
	return path;
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'pma-validate-'));
	fixtures = await buildFixtures(dir);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('valid archives', () => {
	it('accepts the full-featured archive with zero errors and zero warnings', async () => {
		const result = await validateArchive(fixture('valid'));
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.zip64).toBe(false);
		expect(result.counts).toEqual({
			tracks: 2,
			routes: 1,
			waypoints: 2,
			areas: 1,
			collections: 2,
			photos: 2
		});
		expect(result.manifest).toMatchObject({
			format: 'portable-map-archive',
			version: 1,
			status: 'complete'
		});
	});

	it('accepts a partial archive whose failed IDs are still referenced', async () => {
		const result = await validateArchive(fixture('partial'));
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.counts).toEqual({
			tracks: 2,
			routes: 1,
			waypoints: 2,
			areas: 1,
			collections: 2,
			photos: 2
		});
		expect(result.manifest).toMatchObject({ status: 'partial', errors: { tracks: 1, photos: 1 } });
	});

	it('reports entries in central-directory order with compression info', async () => {
		const result = await validateArchive(fixture('valid'));
		const names = result.entries.map((e) => e.name);
		expect(names[0]).toBe('tracks/000001-morning-ridge-run.gpx');
		expect(names.slice(-3)).toEqual(['collections.json', 'errors.json', 'manifest.json']);
		expect(result.entries.every((e) => !e.isDirectory)).toBe(true);

		const photos = result.entries.filter((e) => /^photos\/.*\.jpg$/.test(e.name));
		expect(photos).toHaveLength(2);
		for (const photo of photos) {
			expect(photo.compressionMethod).toBe(0);
			expect(photo.compressedSize).toBe(photo.uncompressedSize);
			expect(photo.uncompressedSize).toBe(512);
		}
		const gpx = result.entries.find((e) => e.name === 'tracks/000001-morning-ridge-run.gpx');
		expect(gpx?.compressionMethod).toBe(8);
		expect(gpx?.compressedSize).toBeLessThan(gpx?.uncompressedSize ?? 0);
	});
});

describe('invalid archives', () => {
	const invalid = Object.entries(FIXTURES).filter(([, f]) => f.expect !== null);

	it('covers the cases goal.md item 7 requires', () => {
		const names = invalid.map(([name]) => name);
		for (const required of [
			'missing-manifest',
			'unknown-major-version',
			'dangling-ref',
			'dangling-attached-to',
			'path-traversal',
			'manifest-not-last',
			'count-mismatch',
			'orphan-sidecar',
			'bad-gpx',
			'schema-violation'
		]) {
			expect(names).toContain(required);
		}
	});

	it.each(invalid.map(([name, f]) => [name, f.expect as string]))(
		'rejects %s with %s',
		async (name, code) => {
			const result = await validateArchive(fixture(name));
			expect(result.valid).toBe(false);
			expect(result.errors.map((e) => e.code)).toContain(code);
			// every fixture breaks exactly one rule, so no unrelated code may fire
			expect([...new Set(result.errors.map((e) => e.code))]).toEqual([code]);
		}
	);

	it('stops early when the manifest is missing or the major version is unknown', async () => {
		const missing = await validateArchive(fixture('missing-manifest'));
		expect(missing.errors).toHaveLength(1);
		expect(missing.manifest).toBeNull();
		expect(missing.entries.length).toBeGreaterThan(0);

		const future = await validateArchive(fixture('unknown-major-version'));
		expect(future.errors).toHaveLength(1);
		expect(future.errors[0]?.entry).toBe('manifest.json');
		expect(future.manifest).toMatchObject({ version: 2 });
	});

	it('names the offending entry for path traversal and dangling references', async () => {
		const traversal = await validateArchive(fixture('path-traversal'));
		expect(traversal.errors[0]).toMatchObject({ code: 'unsafe-name', entry: '../evil.gpx' });
		const nested = await validateArchive(fixture('path-traversal-nested'));
		expect(nested.errors[0]).toMatchObject({ code: 'unsafe-name', entry: 'tracks/../../evil.gpx' });

		const ref = await validateArchive(fixture('dangling-ref'));
		expect(ref.errors[0]?.message).toContain('route/000099');
		const attached = await validateArchive(fixture('dangling-attached-to'));
		expect(attached.errors[0]).toMatchObject({
			code: 'dangling-ref',
			entry: 'photos/000001-summit.json'
		});
	});

	it('rejects a file that is not a ZIP at all', async () => {
		const path = join(dir, 'not-a-zip.zip');
		writeFileSync(path, 'GIF89a this is not a zip file, not even slightly.');
		const result = await validateArchive(path);
		expect(result.valid).toBe(false);
		expect(result.errors.map((e) => e.code)).toEqual(['not-a-zip']);
	});

	it('rejects with an I/O error (not a result) when the file does not exist', async () => {
		await expect(validateArchive(join(dir, 'nope.zip'))).rejects.toThrow(/ENOENT/);
	});

	it('reports unknown but safe entries as warnings only', async () => {
		const { writeZip } = await import('../tools/pma-validate/fixtures/zip-writer.ts');
		const model = FIXTURES['valid']?.build() ?? [];
		const path = join(dir, 'extra-entry.zip');
		writeZip(path, [
			{ name: 'README.txt', data: 'hello' },
			{ name: 'tracks/', data: '', store: true },
			...model.map((e) => ({
				name: e.name,
				data: e.bytes ?? e.text ?? JSON.stringify(e.json),
				store: e.store ?? false
			}))
		]);
		const result = await validateArchive(path);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: 'unknown-entry', entry: 'README.txt' })
		]);
		expect(result.entries.find((e) => e.name === 'tracks/')?.isDirectory).toBe(true);
	});
});

describe('unsafeNameReason', () => {
	it.each([
		'../evil.gpx',
		'tracks/../../evil.gpx',
		'/etc/passwd',
		'C:/evil.gpx',
		'tracks\\evil.gpx',
		'tracks//x.gpx',
		'./x.gpx',
		'tracks/x\u0000.gpx',
		'tracks/x\n.gpx',
		''
	])('flags %j', (name) => {
		expect(unsafeNameReason(name)).not.toBeNull();
	});

	it.each(['manifest.json', 'tracks/000001-a.gpx', 'tracks/', 'photos/000001-é.jpg', 'a..b/c'])(
		'accepts %j',
		(name) => {
			expect(unsafeNameReason(name)).toBeNull();
		}
	);
});

describe('zip64 detection', () => {
	it('sees the Zip64 end-of-central-directory locator', async () => {
		const path = join(dir, 'zip64.zip');
		const writer = new ZipWriter(new Uint8ArrayWriter(), { zip64: true, useWebWorkers: false });
		await writer.add('hello.txt', new TextReader('hello'));
		writeFileSync(path, await writer.close());

		const result = await validateArchive(path);
		expect(result.zip64).toBe(true);
		expect(result.entries.map((e) => e.name)).toEqual(['hello.txt']);
		expect(result.errors.map((e) => e.code)).toEqual(['manifest-missing']);
	});
});

describe('reference reader', () => {
	it('prints collection → member → reference → photo attachment lines', async () => {
		const tree = await readArchiveTree(fixture('valid'));
		const lines = tree.split('\n');
		const indexOf = (needle: string): number => {
			const index = lines.findIndex((l) => l.includes(needle));
			expect(index, `tree should contain ${needle}\n${tree}`).toBeGreaterThanOrEqual(0);
			return index;
		};
		const indent = (index: number): number => /^ */.exec(lines[index] ?? '')?.[0].length ?? 0;

		expect(lines[0]).toContain('Portable Map Archive v1');
		expect(lines[0]).toContain('complete');

		const parent = indexOf('collection/000001 "Trips"');
		const child = indexOf('collection/000002 "Sierra 2025"');
		const member = indexOf(
			'route/000001 "Mount Whitney Loop" [routes/000001-mount-whitney-loop.gpx]'
		);
		const waypoint = indexOf('waypoint/000001 "Trail Camp"');
		const photo = indexOf(
			'+ photo: photo/000001 "Sunrise at Trail Camp" [photos/000001-summit.jpg'
		);
		const reference = indexOf(
			'→ reference: Kearsarge Pass Trail <https://maps.example.com/trail/kearsarge-pass> @ -118.37,36.77'
		);
		const annotations = indexOf('annotations: completedAt=2025-08-03, rating=5');

		expect(child).toBeGreaterThan(parent);
		expect(indent(child)).toBeGreaterThan(indent(parent));
		expect(member).toBeGreaterThan(child);
		expect(indent(member)).toBeGreaterThan(indent(child));
		expect(photo).toBe(waypoint + 1);
		expect(indent(photo)).toBeGreaterThan(indent(waypoint));
		expect(annotations).toBe(reference + 1);

		// many-to-many: the same track is listed under both collections
		expect(lines.filter((l) => l.includes('track/000001 "Morning Ridge Run"'))).toHaveLength(2);

		const loose = indexOf('Not in any collection');
		expect(indexOf('track/000002')).toBeGreaterThan(loose);
		expect(indexOf('waypoint/000002 "Whitney Portal"')).toBeGreaterThan(loose);
		const unattached = indexOf('Unattached photos');
		expect(indexOf('photo: photo/000002')).toBeGreaterThan(unattached);
	});

	it('shows failed members of a partial archive instead of crashing', async () => {
		const tree = await readArchiveTree(fixture('partial'));
		expect(tree).toContain('track/000003 (failed to export: HTTP 500)');
		expect(tree).toContain('(was attached to failed track/000003)');
	});

	it('refuses aborted exports and unknown major versions', async () => {
		await expect(readArchiveTree(fixture('missing-manifest'))).rejects.toThrow(/manifest/);
		await expect(readArchiveTree(fixture('unknown-major-version'))).rejects.toThrow(/version 2/);
		await expect(readArchiveTree(fixture('path-traversal'))).rejects.toThrow(
			/invalid relative path/
		);
	});
});

describe('cli', () => {
	const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
		const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 120_000
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};

	it('exits 0 and prints the tree for a valid archive', () => {
		const result = run([fixture('valid'), '--tree']);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('VALID Portable Map Archive');
		expect(result.stdout).toContain('→ reference: Kearsarge Pass Trail');
	}, 180_000);

	it('exits 1 and names the error code for an invalid archive', () => {
		const result = run([fixture('dangling-ref')]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain('INVALID');
		expect(result.stdout).toContain('[dangling-ref]');
	}, 180_000);

	it('emits machine-readable JSON with --json', () => {
		const stdout = execFileSync(process.execPath, [TSX, CLI, fixture('partial'), '--json'], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 120_000
		});
		const parsed = JSON.parse(stdout) as { valid: boolean; counts: Record<string, number> };
		expect(parsed.valid).toBe(true);
		expect(parsed.counts['tracks']).toBe(2);
	}, 180_000);

	it('exits 2 on usage and I/O errors', () => {
		expect(run([]).status).toBe(2);
		expect(run([join(dir, 'does-not-exist.zip')]).status).toBe(2);
	}, 180_000);
});
