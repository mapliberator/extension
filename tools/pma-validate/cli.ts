#!/usr/bin/env -S npx tsx
/**
 * pma-validate <archive.zip> [--tree] [--json]
 * Exit codes: 0 valid · 1 invalid · 2 usage or I/O error.
 */
import { readArchiveTree } from './reader.ts';
import { validateArchive } from './validate.ts';
import type { Issue } from './validate.ts';

const USAGE = `Usage: pma-validate <archive.zip> [--tree] [--json]

Validates a Portable Map Archive (1.0-draft).
  --tree   also print the object tree (collections → members → references → photos)
  --json   print the full validation result as JSON
Exit codes: 0 valid, 1 invalid, 2 usage or I/O error.
`;

const line = (kind: string, issue: Issue): string =>
	`  ${kind} [${issue.code}]${issue.entry === undefined ? '' : ` ${issue.entry}:`} ${issue.message}`;

async function main(argv: string[]): Promise<number> {
	const flags = new Set(argv.filter((a) => a.startsWith('--')));
	const paths = argv.filter((a) => !a.startsWith('--'));
	if (flags.has('--help')) {
		process.stdout.write(USAGE);
		return 0;
	}
	const unknown = [...flags].filter((f) => f !== '--tree' && f !== '--json');
	const path = paths[0];
	if (path === undefined || paths.length !== 1 || unknown.length > 0) {
		process.stderr.write(USAGE);
		return 2;
	}

	const result = await validateArchive(path);
	let tree: string | null = null;
	if (flags.has('--tree') && result.valid) tree = await readArchiveTree(path);

	if (flags.has('--json')) {
		process.stdout.write(
			JSON.stringify(tree === null ? result : { ...result, tree }, null, 2) + '\n'
		);
		return result.valid ? 0 : 1;
	}

	const counts = Object.entries(result.counts)
		.map(([key, value]) => `${key} ${value}`)
		.join(', ');
	const out: string[] = [
		`${path}: ${result.valid ? 'VALID' : 'INVALID'} Portable Map Archive`,
		`  ${result.entries.length} entries${result.zip64 ? ' (Zip64)' : ''}; ${counts}`
	];
	for (const issue of result.errors) out.push(line('error  ', issue));
	for (const issue of result.warnings) out.push(line('warning', issue));
	if (tree !== null) out.push('', tree.trimEnd());
	else if (flags.has('--tree')) out.push('', '(no tree: the archive is invalid)');
	process.stdout.write(out.join('\n') + '\n');
	return result.valid ? 0 : 1;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(`pma-validate: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 2;
	}
);
