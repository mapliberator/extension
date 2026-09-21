import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSpecSchemas, SCHEMA_DIR } from '../scripts/generate-spec-schemas.ts';

const SPEC_DIR = resolve(import.meta.dirname, '..', 'spec');
const SPEC_DOC = join(SPEC_DIR, 'portable-map-archive-1.0-draft.md');

describe('spec/schemas', () => {
	const generated = generateSpecSchemas();

	it('lives in spec/schemas', () => {
		expect(resolve(SCHEMA_DIR)).toBe(join(SPEC_DIR, 'schemas'));
	});

	it('contains exactly the generated files: none missing, none extra', () => {
		expect(readdirSync(SCHEMA_DIR).sort()).toEqual(Object.keys(generated).sort());
		expect(Object.keys(generated).length).toBeGreaterThanOrEqual(7);
	});

	it.each(Object.keys(generated))('%s is byte-identical to a fresh generation', (name) => {
		const committed = readFileSync(join(SCHEMA_DIR, name), 'utf8');
		expect(committed, `run: npx tsx scripts/generate-spec-schemas.ts`).toBe(generated[name]);
	});

	it.each(Object.keys(generated))('%s is a draft 2020-12 schema with a 1.0-draft $id', (name) => {
		const schema = JSON.parse(generated[name] ?? '{}') as Record<string, unknown>;
		expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
		expect(String(schema['$id'])).toContain(`/1.0-draft/schemas/${name}`);
	});
});

describe('spec document', () => {
	it('exists, with its own README and license', () => {
		for (const file of [SPEC_DOC, join(SPEC_DIR, 'README.md'), join(SPEC_DIR, 'LICENSE.md')]) {
			expect(existsSync(file), file).toBe(true);
		}
		expect(readFileSync(join(SPEC_DIR, 'LICENSE.md'), 'utf8')).toMatch(/CC BY 4\.0|CC-BY-4\.0/);
	});

	it('declares its own version, 1.0-draft', () => {
		expect(readFileSync(SPEC_DOC, 'utf8')).toContain('1.0-draft');
	});

	it('references every schema file by name', () => {
		const text = readFileSync(SPEC_DOC, 'utf8');
		for (const name of Object.keys(generateSpecSchemas())) {
			expect(text, name).toContain(`schemas/${name}`);
		}
	});

	it('documents every error and warning code the validator can emit', () => {
		const text = readFileSync(SPEC_DOC, 'utf8');
		const validator = readFileSync(
			resolve(SPEC_DIR, '..', 'tools', 'pma-validate', 'validate.ts'),
			'utf8'
		);
		const codes = new Set(
			[...validator.matchAll(/\b(?:error|warn)\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1] as string)
		);
		expect(codes.size).toBeGreaterThan(15);
		for (const code of codes) expect(text, code).toContain(`\`${code}\``);
	});
});
