/**
 * Proves that tools/pma-validate (validator, reference reader, CLI, fixtures) is written
 * strictly from spec/: it imports nothing from src/, directly or transitively, and depends only
 * on Node built-ins plus a short allowlist of packages.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync
} from 'node:fs';
import { writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const TOOL_DIR = join(ROOT, 'tools', 'pma-validate');
const SPEC_DIR = join(ROOT, 'spec');
const ALLOWED_PACKAGES = ['yauzl', 'ajv', 'ajv/dist/2020.js', 'saxes'];
const SRC_PATH = /(^|[^A-Za-z0-9_-])src[\\/]/;

interface Violation {
	kind: 'outside-allowed-dirs' | 'bare-specifier' | 'unresolved' | 'src-path-string';
	file: string;
	detail: string;
}

interface Report {
	files: string[];
	packages: string[];
	violations: Violation[];
}

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...listTsFiles(path));
		else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) out.push(path);
	}
	return out;
}

function isInside(file: string, dir: string): boolean {
	const rel = relative(dir, file);
	return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

function resolveRelative(from: string, specifier: string): string | null {
	const base = resolve(dirname(from), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.js`,
		base.replace(/\.js$/, '.ts'),
		join(base, 'index.ts'),
		join(base, 'index.js')
	];
	return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Walks the import graph from `entryFiles`; every reached file must be inside `allowedDirs`. */
function checkIndependence(entryFiles: string[], allowedDirs: string[]): Report {
	const builtins = new Set(builtinModules);
	const seen = new Set<string>();
	const packages = new Set<string>();
	const violations: Violation[] = [];
	const queue = [...entryFiles];

	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		if (!allowedDirs.some((dir) => isInside(file as string, dir))) {
			violations.push({ kind: 'outside-allowed-dirs', file, detail: 'reached through imports' });
			continue; // do not walk the forbidden graph any further
		}
		if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(file)) continue; // e.g. a JSON schema
		const text = readFileSync(file, 'utf8');

		text.split('\n').forEach((line, index) => {
			if (SRC_PATH.test(line)) {
				violations.push({
					kind: 'src-path-string',
					file,
					detail: `line ${index + 1}: ${line.trim()}`
				});
			}
		});

		// imports, re-exports, import types, dynamic import() and require() with literal arguments
		const info = ts.preProcessFile(text, true, true);
		const specifiers = [
			...info.importedFiles.map((f) => f.fileName),
			...info.referencedFiles.map((f) => f.fileName)
		];
		for (const specifier of specifiers) {
			if (specifier.startsWith('.') || specifier.startsWith('/')) {
				const target = resolveRelative(file, specifier);
				if (target === null) violations.push({ kind: 'unresolved', file, detail: specifier });
				else queue.push(target);
			} else if (specifier.startsWith('node:') || builtins.has(specifier)) {
				// Node built-in
			} else if (ALLOWED_PACKAGES.includes(specifier)) {
				packages.add(specifier);
			} else {
				violations.push({ kind: 'bare-specifier', file, detail: specifier });
			}
		}

		// dynamic import()/require() whose argument is not a plain string literal cannot be checked
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
				const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
				const arg = node.arguments[0];
				if ((isImport || isRequire) && arg && !ts.isStringLiteralLike(arg)) {
					violations.push({ kind: 'unresolved', file, detail: `computed ${node.getText()}` });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return { files: [...seen].sort(), packages: [...packages].sort(), violations };
}

describe('tools/pma-validate is independent of src/', () => {
	const entryFiles = listTsFiles(TOOL_DIR);
	const report = checkIndependence(entryFiles, [TOOL_DIR, SPEC_DIR]);

	it('finds the validator, reader, CLI and fixture builder', () => {
		const names = entryFiles.map((f) => relative(TOOL_DIR, f).split(sep).join('/'));
		expect(names).toEqual(
			expect.arrayContaining([
				'validate.ts',
				'reader.ts',
				'cli.ts',
				'fixtures/build-fixtures.ts',
				'fixtures/zip-writer.ts'
			])
		);
	});

	it('reaches only files under tools/pma-validate/ or spec/, and only allowlisted packages', () => {
		expect(report.violations).toEqual([]);
		for (const file of report.files) {
			expect(isInside(file, TOOL_DIR) || isInside(file, SPEC_DIR), file).toBe(true);
			expect(isInside(file, join(ROOT, 'src')), file).toBe(false);
		}
	});

	it('actually walked the graph (the check is not vacuous)', () => {
		expect(report.files).toContain(join(TOOL_DIR, 'zip.ts'));
		expect(report.packages).toEqual(expect.arrayContaining(['yauzl', 'ajv/dist/2020.js', 'saxes']));
	});

	it('loads the JSON Schemas from spec/schemas at run time', () => {
		const text = readFileSync(join(TOOL_DIR, 'validate.ts'), 'utf8');
		expect(text).toMatch(/'spec', 'schemas'/);
		expect(text).toContain('import.meta.url');
	});
});

describe('the checker catches violations (self-test)', () => {
	const sandbox = mkdtempSync(join(tmpdir(), 'pma-independence-'));
	const toolDir = join(sandbox, 'tools', 'pma-validate');
	mkdirSync(toolDir, { recursive: true });
	mkdirSync(join(sandbox, 'src', 'shared'), { recursive: true });
	writeFileSync(join(sandbox, 'src', 'shared', 'schemas.ts'), 'export const x = 1;\n');
	const write = (name: string, text: string): string => {
		const path = join(toolDir, name);
		writeFileSync(path, text);
		return path;
	};
	const kinds = (file: string): string[] =>
		checkIndependence([file], [toolDir]).violations.map((v) => v.kind);

	afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

	it('flags a direct import from src/', () => {
		const file = write(
			'direct.ts',
			`import { x } from '../../src/shared/schemas.ts';\nexport { x };\n`
		);
		const report = checkIndependence([file], [toolDir]);
		expect(report.violations.map((v) => v.kind)).toContain('outside-allowed-dirs');
		expect(report.violations.map((v) => v.kind)).toContain('src-path-string');
		expect(
			report.violations.some((v) => v.file === join(sandbox, 'src', 'shared', 'schemas.ts'))
		).toBe(true);
	});

	it('flags transitive, re-exported, type-only, dynamic and require() imports', () => {
		write('leaf.ts', `export * from '../../src/shared/schemas.ts';\n`);
		expect(kinds(write('transitive.ts', `import './leaf.ts';\n`))).toContain(
			'outside-allowed-dirs'
		);
		const up = ['..', '..', 's' + 'rc', 'shared', 'schemas.ts'].join('/');
		expect(
			kinds(write('type-only.ts', `import type { x } from '${up}';\nexport type X = typeof x;\n`))
		).toContain('outside-allowed-dirs');
		expect(kinds(write('dynamic.ts', `export const m = await import('${up}');\n`))).toContain(
			'outside-allowed-dirs'
		);
		expect(kinds(write('required.cjs', `module.exports = require('${up}');\n`))).toContain(
			'outside-allowed-dirs'
		);
		expect(
			kinds(write('computed.ts', `const p = '${up}';\nexport const m = await import(p);\n`))
		).toContain('unresolved');
	});

	it('flags packages that are not on the allowlist, and string paths into src/', () => {
		expect(kinds(write('zod.ts', `import { z } from 'zod';\nexport { z };\n`))).toEqual([
			'bare-specifier'
		]);
		expect(
			kinds(
				write(
					'fs-read.ts',
					`import { readFileSync } from 'node:fs';\nexport const s = readFileSync('../../src/shared/schemas.ts');\n`
				)
			)
		).toEqual(['src-path-string']);
	});

	it('passes a clean file', () => {
		write('dep.ts', `export const y = 2;\n`);
		const file = write(
			'clean.ts',
			`import yauzl from 'yauzl';\nimport { y } from './dep.ts';\nexport { yauzl, y };\n`
		);
		expect(checkIndependence([file], [toolDir]).violations).toEqual([]);
	});
});
