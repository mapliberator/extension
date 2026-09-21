import { describe, expect, it } from 'vitest';
import {
	archiveId,
	baseName,
	extensionForContentType,
	formatSequence,
	normalizeContentType,
	SLUG_MAX,
	slugify
} from '../src/archive/filenames.ts';
import { FileNameSchema } from '../src/shared/schemas.ts';

describe('slugify', () => {
	it('lowercases and hyphenates', () => {
		expect(slugify('Mount Whitney Loop')).toBe('mount-whitney-loop');
	});

	it('ASCII-folds accents and ligatures', () => {
		expect(slugify('Sentier des Crêtes – Übergang à l’été')).toBe(
			'sentier-des-cretes-ubergang-a-l-ete'
		);
		expect(slugify('Straße Ærø Øst Łódź')).toBe('strasse-aero-ost-lodz');
	});

	it('removes path separators, dots and traversal sequences', () => {
		const slug = slugify('Morning loop / ridge ../summit\\..\\evil');
		expect(slug).toBe('morning-loop-ridge-summit-evil');
		expect(slug).not.toMatch(/[/\\.]/);
	});

	it('removes control characters and NULs', () => {
		expect(slugify('a\u0000b\u001fc\nd\te')).toBe('a-b-c-d-e');
	});

	it('caps the length without a trailing hyphen', () => {
		const slug = slugify(`${'a'.repeat(SLUG_MAX - 1)} ${'b'.repeat(80)}`);
		expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
		expect(slug.endsWith('-')).toBe(false);
	});

	it('returns an empty slug when nothing survives', () => {
		expect(slugify('🏔️🥾')).toBe('');
		expect(slugify('../..')).toBe('');
		expect(slugify('   ')).toBe('');
	});
});

describe('baseName', () => {
	it('prefixes the zero-padded sequence', () => {
		expect(baseName(1, 'Mount Whitney Loop')).toBe('000001-mount-whitney-loop');
		expect(formatSequence(412)).toBe('000412');
		expect(formatSequence(1234567)).toBe('1234567');
	});

	it('is number-only when the name has no usable characters', () => {
		expect(baseName(7, '🏔️🥾')).toBe('000007');
		expect(baseName(8, null)).toBe('000008');
	});

	it('keeps identical names unique through the sequence', () => {
		expect(baseName(5, 'Evening walk')).not.toBe(baseName(6, 'Evening walk'));
	});

	it('always satisfies the archive file-name schema', () => {
		const hostile = [
			'../../etc/passwd',
			'C:\\Windows\\system32',
			'.hidden',
			'-rf',
			'a'.repeat(500),
			'CON',
			'\u202Egpx.exe'
		];
		hostile.forEach((name, index) => {
			for (const ext of ['gpx', 'json', extensionForContentType('image/jpeg')]) {
				const file = `${baseName(index + 1, name)}.${ext}`;
				expect(FileNameSchema.safeParse(file).success, file).toBe(true);
				expect(file).toMatch(/^\d{6}/);
			}
		});
	});
});

describe('archiveId', () => {
	it('is <type>/<sequence>', () => {
		expect(archiveId('route', 1)).toBe('route/000001');
		expect(archiveId('waypoint', 412)).toBe('waypoint/000412');
	});
});

describe('photo extensions', () => {
	it('derive from Content-Type, ignoring parameters and case', () => {
		expect(extensionForContentType('image/jpeg')).toBe('jpg');
		expect(extensionForContentType('IMAGE/PNG; charset=binary')).toBe('png');
		expect(extensionForContentType('image/heic')).toBe('heic');
	});

	it('never trust unknown or hostile types', () => {
		expect(extensionForContentType('application/x-msdownload')).toBe('bin');
		expect(extensionForContentType('image/../../evil')).toBe('bin');
		expect(extensionForContentType(null)).toBe('bin');
		expect(normalizeContentType(undefined)).toBe('application/octet-stream');
	});
});
