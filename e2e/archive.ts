/** Archive inspection for e2e assertions, built on the spec-only reader in tools/pma-validate. */
import { readFileSync } from 'node:fs';
import { listEntries, openZip, readEntry } from '../tools/pma-validate/zip.ts';

export interface ArchiveContents {
	/** Entry names in central-directory order. */
	names: string[];
	read(name: string): Buffer;
	json<T = any>(name: string): T;
	/** Decompressed bytes of every entry, for sentinel scans. */
	all(): Map<string, Buffer>;
}

export async function openArchive(path: string): Promise<ArchiveContents> {
	const zip = await openZip(path);
	const entries = await listEntries(zip);
	const data = new Map<string, Buffer>();
	for (const raw of entries) {
		if (raw.info.isDirectory) continue;
		data.set(raw.info.name, await readEntry(zip, raw.entry));
	}
	zip.close();
	const read = (name: string) => {
		const buffer = data.get(name);
		if (!buffer)
			throw new Error(`archive has no entry ${name}; has: ${[...data.keys()].join(', ')}`);
		return buffer;
	};
	return {
		names: entries.map((entry) => entry.info.name),
		read,
		json: (name) => JSON.parse(read(name).toString('utf8')),
		all: () => data
	};
}

/** Every place a needle occurs: the raw ZIP bytes and each entry's decompressed bytes. */
export function findNeedle(path: string, contents: ArchiveContents, needle: string): string[] {
	const hits: string[] = [];
	const bytes = Buffer.from(needle, 'utf8');
	if (readFileSync(path).includes(bytes)) hits.push('(raw zip bytes)');
	for (const [name, buffer] of contents.all()) {
		if (buffer.includes(bytes)) hits.push(name);
	}
	return hits;
}

/** Invariant: nothing fake-source planted as sensitive appears anywhere in the archive. */
export function findSentinels(
	path: string,
	contents: ArchiveContents,
	sentinels: string[]
): Record<string, string[]> {
	const found: Record<string, string[]> = {};
	for (const sentinel of sentinels) {
		const hits = findNeedle(path, contents, sentinel);
		if (hits.length > 0) found[sentinel] = hits;
	}
	return found;
}
