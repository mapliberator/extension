/**
 * pma-validate — conformance checker for Portable Map Archive 1.0-draft.
 *
 * Written strictly from `spec/` (the document and the JSON Schemas). It imports nothing from
 * the MapLiberator extension source; section numbers in comments refer to
 * spec/portable-map-archive-1.0-draft.md.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { SaxesParser } from 'saxes';
import type { ZipFile } from 'yauzl';
import { detectZip64, listEntries, openZip, readEntry, streamEntry } from './zip.ts';
import type { EntryInfo, RawEntry } from './zip.ts';

export type { EntryInfo } from './zip.ts';

export interface Issue {
	code: string;
	message: string;
	entry?: string;
}

export type CountKey = 'tracks' | 'routes' | 'waypoints' | 'areas' | 'collections' | 'photos';

export interface ValidationResult {
	valid: boolean;
	errors: Issue[];
	warnings: Issue[];
	/** parsed manifest.json, if readable */
	manifest: unknown | null;
	/** in central-directory order */
	entries: EntryInfo[];
	/** objects actually present in the archive */
	counts: Record<CountKey, number>;
	/** the archive uses Zip64 structures */
	zip64: boolean;
}

export const SUPPORTED_MAJOR_VERSION = 1;
export const FORMAT_NAME = 'portable-map-archive';
const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
const COUNT_KEYS: CountKey[] = ['tracks', 'routes', 'waypoints', 'areas', 'collections', 'photos'];
const PLURAL: Record<string, CountKey> = {
	track: 'tracks',
	route: 'routes',
	waypoint: 'waypoints',
	area: 'areas',
	collection: 'collections',
	photo: 'photos'
};
const LINE_DIRS: Record<string, 'track' | 'route'> = { tracks: 'track', routes: 'route' };
const KNOWN_DIRS = new Set(['tracks/', 'routes/', 'waypoints/', 'areas/', 'photos/']);
const MAX_SCHEMA_ISSUES_PER_DOCUMENT = 10;

type SchemaName =
	'manifest' | 'line-sidecar' | 'photo-sidecar' | 'waypoints' | 'areas' | 'collections' | 'errors';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'schemas');
let validators: Map<string, ValidateFunction> | null = null;

function schemaValidator(name: SchemaName): ValidateFunction {
	if (!validators) {
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		validators = new Map();
		for (const file of readdirSync(SCHEMA_DIR)) {
			if (!file.endsWith('.schema.json')) continue;
			const schema: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8'));
			validators.set(file.replace(/\.schema\.json$/, ''), ajv.compile(schema as object));
		}
	}
	const validate = validators.get(name);
	if (!validate) throw new Error(`spec/schemas/${name}.schema.json is missing`);
	return validate;
}

/** §4.2 — returns why an entry name is unsafe, or null when it is safe. */
export function unsafeNameReason(name: string): string | null {
	if (name.length === 0) return 'empty name';
	if (name.includes('\\')) return 'contains a backslash';
	if (name.startsWith('/')) return 'absolute path';
	if (/^[A-Za-z]:/.test(name)) return 'starts with a drive letter';
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'contains a control character';
	const segments = name.split('/');
	if (name.endsWith('/')) segments.pop(); // directory entry
	for (const segment of segments) {
		if (segment === '..') return 'contains a ".." segment';
		if (segment === '.') return 'contains a "." segment';
		if (segment === '') return 'contains an empty path segment';
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyCounts(): Record<CountKey, number> {
	return { tracks: 0, routes: 0, waypoints: 0, areas: 0, collections: 0, photos: 0 };
}

/** §6 — streams a GPX entry through a SAX parser; returns a problem description or null. */
async function checkGpx(
	zip: ZipFile,
	raw: RawEntry
): Promise<{ problem: string | null; namespace: string | null }> {
	const parser = new SaxesParser({ xmlns: true, position: true });
	let depth = 0;
	let root: { local: string; uri: string } | null = null;
	let points = 0;
	let problem: string | null = null;
	parser.on('error', (err) => {
		problem ??= `not well-formed XML: ${err.message.replace(/\s+/g, ' ')}`;
	});
	parser.on('opentag', (tag) => {
		if (depth === 0) root = { local: tag.local, uri: tag.uri };
		depth++;
		if (tag.local === 'trkpt' || tag.local === 'rtept') {
			points++;
			const lat = Number(tag.attributes['lat']?.value);
			const lon = Number(tag.attributes['lon']?.value);
			const bad =
				!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180;
			if (bad) problem ??= `<${tag.local}> #${points} has missing or out-of-range lat/lon`;
		}
	});
	parser.on('closetag', () => {
		depth--;
	});
	const decoder = new TextDecoder('utf-8');
	try {
		await streamEntry(zip, raw.entry, (chunk) => {
			if (!problem) parser.write(decoder.decode(chunk, { stream: true }));
		});
		if (!problem) parser.write(decoder.decode()).close();
	} catch (err) {
		problem ??= `unreadable entry: ${(err as Error).message}`;
	}
	const seenRoot = root as { local: string; uri: string } | null;
	if (!problem) {
		if (!seenRoot) problem = 'no root element';
		else if (seenRoot.local !== 'gpx') problem = `root element is <${seenRoot.local}>, not <gpx>`;
		else if (points === 0) problem = 'contains no <trkpt> or <rtept>';
	}
	return { problem, namespace: seenRoot?.uri ?? null };
}

export async function validateArchive(path: string): Promise<ValidationResult> {
	const result: ValidationResult = {
		valid: false,
		errors: [],
		warnings: [],
		manifest: null,
		entries: [],
		counts: emptyCounts(),
		zip64: false
	};
	const error = (code: string, message: string, entry?: string): void => {
		result.errors.push(entry === undefined ? { code, message } : { code, message, entry });
	};
	const warn = (code: string, message: string, entry?: string): void => {
		result.warnings.push(entry === undefined ? { code, message } : { code, message, entry });
	};

	await stat(path); // a missing file is an I/O error for the caller, not a validation result

	let zip: ZipFile;
	let raws: RawEntry[];
	try {
		zip = await openZip(path);
	} catch (err) {
		error('not-a-zip', `not a readable ZIP file: ${(err as Error).message}`);
		return result;
	}

	try {
		try {
			raws = await listEntries(zip);
		} catch (err) {
			error('not-a-zip', `corrupt central directory: ${(err as Error).message}`);
			return result;
		}
		result.entries = raws.map((r) => r.info);
		result.zip64 = await detectZip64(path, raws);
		await validateOpened(zip, raws, result, error, warn);
	} finally {
		zip.close();
	}
	result.valid = result.errors.length === 0;
	return result;
}

async function validateOpened(
	zip: ZipFile,
	raws: RawEntry[],
	result: ValidationResult,
	error: (code: string, message: string, entry?: string) => void,
	warn: (code: string, message: string, entry?: string) => void
): Promise<void> {
	/** Reads and parses a JSON entry; reports `json-invalid` and returns undefined on failure. */
	const readJson = async (raw: RawEntry): Promise<unknown> => {
		try {
			const bytes = await readEntry(zip, raw.entry);
			return JSON.parse(
				new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
			) as unknown;
		} catch (err) {
			error('json-invalid', `not valid UTF-8 JSON: ${(err as Error).message}`, raw.info.name);
			return undefined;
		}
	};
	const checkSchema = (schema: SchemaName, value: unknown, entry: string): boolean => {
		const validate = schemaValidator(schema);
		if (validate(value)) return true;
		const issues = validate.errors ?? [];
		for (const issue of issues.slice(0, MAX_SCHEMA_ISSUES_PER_DOCUMENT)) {
			const where = issue.instancePath === '' ? '(document root)' : issue.instancePath;
			error('schema', `${schema}.schema.json: ${where} ${issue.message ?? 'is invalid'}`, entry);
		}
		if (issues.length > MAX_SCHEMA_ISSUES_PER_DOCUMENT) {
			const more = issues.length - MAX_SCHEMA_ISSUES_PER_DOCUMENT;
			error('schema', `${schema}.schema.json: … and ${more} more violations`, entry);
		}
		return false;
	};

	// ── §4.2 entry names ────────────────────────────────────────────────────────────────────
	const usable: RawEntry[] = [];
	const seenNames = new Map<string, string>();
	for (const raw of raws) {
		const name = raw.info.name;
		const reason = raw.nameIsUtf8 ? unsafeNameReason(name) : 'name is not valid UTF-8';
		if (reason) {
			error('unsafe-name', `unsafe entry name ${JSON.stringify(name)}: ${reason}`, name);
			continue;
		}
		const folded = name.toLowerCase();
		const previous = seenNames.get(folded);
		if (previous !== undefined) {
			const how =
				previous === name ? 'appears more than once' : `differs from "${previous}" only by case`;
			error('duplicate-entry', `entry name ${how}`, name);
			continue;
		}
		seenNames.set(folded, name);
		if (raw.encrypted) {
			error('encrypted-entry', 'entries must not be encrypted', name);
			continue;
		}
		if (raw.info.compressionMethod !== 0 && raw.info.compressionMethod !== 8) {
			const method = raw.info.compressionMethod;
			error('unsupported-compression', `compression method ${method} is not 0 or 8`, name);
			continue;
		}
		usable.push(raw);
	}

	// ── §11 manifest: presence, format, major version. Without these nothing else means much. ─
	const manifestEntry = usable.find((r) => r.info.name === 'manifest.json');
	if (!manifestEntry) {
		error('manifest-missing', 'no manifest.json: this is an aborted export, not an archive');
		return;
	}
	const manifest = await readJson(manifestEntry);
	if (manifest === undefined) return;
	result.manifest = manifest;
	if (!isRecord(manifest) || manifest['format'] !== FORMAT_NAME) {
		const found = isRecord(manifest) ? JSON.stringify(manifest['format']) : typeof manifest;
		error(
			'unsupported-format',
			`manifest "format" is ${found}, not "${FORMAT_NAME}"`,
			'manifest.json'
		);
		return;
	}
	if (manifest['version'] !== SUPPORTED_MAJOR_VERSION) {
		const found = JSON.stringify(manifest['version']);
		error(
			'unsupported-version',
			`manifest "version" is ${found}; this validator supports major version ${SUPPORTED_MAJOR_VERSION} only`,
			'manifest.json'
		);
		return;
	}
	const manifestOk = checkSchema('manifest', manifest, 'manifest.json');

	const lastInDirectory = raws[raws.length - 1] === manifestEntry;
	const greatestOffset = raws.every(
		(r) => r === manifestEntry || r.localHeaderOffset < manifestEntry.localHeaderOffset
	);
	if (!lastInDirectory) {
		error(
			'manifest-not-last',
			'manifest.json is not the last central-directory entry',
			'manifest.json'
		);
	} else if (!greatestOffset) {
		error(
			'manifest-not-last',
			'manifest.json is not the last entry written in the file',
			'manifest.json'
		);
	}

	// ── §3 layout: classify every entry ─────────────────────────────────────────────────────
	interface ObjectFile {
		raw: RawEntry;
		claimedBy: string | null;
	}
	const lineFiles = new Map<string, ObjectFile>(); // "tracks/x.gpx" → …
	const photoFiles = new Map<string, ObjectFile>();
	const lineSidecars: RawEntry[] = [];
	const photoSidecars: RawEntry[] = [];
	const singles = new Map<string, RawEntry>();
	let lastObjectIndex = -1;

	for (const raw of usable) {
		const name = raw.info.name;
		if (raw.info.isDirectory) {
			if (!KNOWN_DIRS.has(name))
				warn('unknown-entry', 'directory is not part of the 1.x layout', name);
			continue;
		}
		if (name === 'manifest.json' || name === 'collections.json' || name === 'errors.json') {
			singles.set(name, raw);
			continue;
		}
		const match = /^(tracks|routes|photos|waypoints|areas)\/([^/]+)$/.exec(name);
		const dir = match?.[1];
		const base = match?.[2];
		let known = true;
		if (dir === undefined || base === undefined) known = false;
		else if (dir === 'waypoints' || dir === 'areas') {
			if (base === `${dir}.geojson`) singles.set(name, raw);
			else known = false;
		} else if (dir === 'photos') {
			if (base.endsWith('.json')) photoSidecars.push(raw);
			else photoFiles.set(name, { raw, claimedBy: null });
		} else if (base.endsWith('.json')) lineSidecars.push(raw);
		else if (base.endsWith('.gpx')) lineFiles.set(name, { raw, claimedBy: null });
		else known = false;

		if (known) lastObjectIndex = Math.max(lastObjectIndex, raw.index);
		else warn('unknown-entry', 'entry is not part of the 1.x layout; importers ignore it', name);
	}

	for (const required of ['collections.json', 'errors.json']) {
		const raw = singles.get(required);
		if (!raw) error('required-entry-missing', `${required} must be present in a finished archive`);
		else if (raw.index < lastObjectIndex) {
			error('entry-order', `${required} must come after all object entries`, required);
		}
	}

	// ── §5 identity ─────────────────────────────────────────────────────────────────────────
	const present = new Map<string, string>(); // id → entry that defines it
	const register = (id: unknown, entry: string): void => {
		if (typeof id !== 'string') return; // already reported by the schema
		const previous = present.get(id);
		if (previous !== undefined) {
			error('duplicate-id', `ID ${id} is already defined by ${previous}`, entry);
			return;
		}
		present.set(id, entry);
	};

	// ── §8 line sidecars, §6 GPX ────────────────────────────────────────────────────────────
	const pair = (raw: RawEntry, sidecar: unknown, files: Map<string, ObjectFile>): void => {
		const name = raw.info.name;
		const file = isRecord(sidecar) ? sidecar['file'] : undefined;
		if (typeof file !== 'string') return; // schema error already reported
		const target = files.get(`${name.slice(0, name.indexOf('/'))}/${file}`);
		if (!target) {
			error('orphan-sidecar', `sidecar names "${file}", which is not in the same directory`, name);
		} else if (target.claimedBy !== null) {
			const other = target.claimedBy;
			error('duplicate-sidecar', `"${file}" is already described by ${other}`, name);
		} else target.claimedBy = name;
	};

	for (const raw of lineSidecars) {
		const name = raw.info.name;
		const sidecar = await readJson(raw);
		if (sidecar === undefined) continue;
		checkSchema('line-sidecar', sidecar, name);
		pair(raw, sidecar, lineFiles);
		if (!isRecord(sidecar)) continue;
		const expected = LINE_DIRS[name.slice(0, name.indexOf('/'))];
		const kind = sidecar['kind'];
		const id = sidecar['id'];
		if ((kind === 'track' || kind === 'route') && kind !== expected) {
			error('kind-mismatch', `sidecar kind "${kind}" does not match its directory`, name);
		}
		if (typeof id === 'string' && /^(track|route)\//.test(id) && !id.startsWith(`${expected}/`)) {
			error('kind-mismatch', `ID ${id} does not match its directory`, name);
		}
		register(id, name);
	}
	for (const [name, file] of lineFiles) {
		if (file.claimedBy === null)
			error('missing-sidecar', 'GPX file has no sidecar naming it', name);
		const gpx = await checkGpx(zip, file.raw);
		if (gpx.problem) error('gpx-invalid', gpx.problem, name);
		else if (gpx.namespace !== GPX_NAMESPACE) {
			warn('gpx-namespace', `root namespace is "${gpx.namespace ?? ''}", not GPX 1.1`, name);
		}
		if (name.startsWith('tracks/')) result.counts.tracks++;
		else result.counts.routes++;
	}

	// ── §10 photos (sidecars only: photo bytes are never read) ──────────────────────────────
	const attachments: { entry: string; id: string }[] = [];
	for (const raw of photoSidecars) {
		const name = raw.info.name;
		const sidecar = await readJson(raw);
		if (sidecar === undefined) continue;
		checkSchema('photo-sidecar', sidecar, name);
		pair(raw, sidecar, photoFiles);
		if (!isRecord(sidecar)) continue;
		register(sidecar['id'], name);
		const attachedTo = sidecar['attachedTo'];
		if (typeof attachedTo === 'string') attachments.push({ entry: name, id: attachedTo });
	}
	for (const [name, file] of photoFiles) {
		if (file.claimedBy === null) error('missing-sidecar', 'photo has no sidecar naming it', name);
		result.counts.photos++;
	}

	// ── §7 aggregated GeoJSON ───────────────────────────────────────────────────────────────
	for (const kind of ['waypoints', 'areas'] as const) {
		const name = `${kind}/${kind}.geojson`;
		const raw = singles.get(name);
		if (!raw) continue;
		const collection = await readJson(raw);
		if (collection === undefined) continue;
		checkSchema(kind, collection, name);
		const features = isRecord(collection) ? collection['features'] : undefined;
		if (!Array.isArray(features)) continue;
		for (const feature of features as unknown[]) {
			if (isRecord(feature)) register(feature['id'], name);
		}
		result.counts[kind] = features.length;
	}

	// ── §12 errors.json ─────────────────────────────────────────────────────────────────────
	const failed = new Set<string>();
	const errorCounts = emptyCounts();
	let errorEntries: number | null = null;
	const errorsRaw = singles.get('errors.json');
	const errorsDoc = errorsRaw ? await readJson(errorsRaw) : undefined;
	if (errorsDoc !== undefined) {
		checkSchema('errors', errorsDoc, 'errors.json');
		if (Array.isArray(errorsDoc)) {
			errorEntries = errorsDoc.length;
			for (const item of errorsDoc as unknown[]) {
				if (!isRecord(item)) continue;
				const type = item['type'];
				const id = item['id'];
				const key = typeof type === 'string' ? PLURAL[type] : undefined;
				if (key) errorCounts[key]++;
				if (typeof id !== 'string') continue;
				if (typeof type === 'string' && key && !id.startsWith(`${type}/`)) {
					error(
						'kind-mismatch',
						`error entry type "${type}" does not match ID ${id}`,
						'errors.json'
					);
				}
				const definedBy = present.get(id);
				if (failed.has(id)) error('duplicate-id', `ID ${id} is listed twice`, 'errors.json');
				if (definedBy !== undefined) {
					error(
						'duplicate-id',
						`ID ${id} is recorded as failed but present in ${definedBy}`,
						'errors.json'
					);
				}
				failed.add(id);
			}
		}
	}

	// ── §9 collections ──────────────────────────────────────────────────────────────────────
	const resolves = (id: string): boolean => present.has(id) || failed.has(id);
	const collectionsRaw = singles.get('collections.json');
	const collectionsDoc = collectionsRaw ? await readJson(collectionsRaw) : undefined;
	const parents = new Map<string, string>();
	if (collectionsDoc !== undefined) {
		checkSchema('collections', collectionsDoc, 'collections.json');
		const list = isRecord(collectionsDoc) ? collectionsDoc['collections'] : undefined;
		const collections = Array.isArray(list) ? (list as unknown[]).filter(isRecord) : [];
		result.counts.collections = collections.length;
		for (const collection of collections) register(collection['id'], 'collections.json');
		for (const collection of collections) {
			const id = String(collection['id']);
			const parent = collection['parent'];
			if (typeof parent === 'string') {
				if (!resolves(parent)) {
					error(
						'dangling-ref',
						`${id}: parent ${parent} is not in the archive`,
						'collections.json'
					);
				} else parents.set(id, parent);
			}
			const members = Array.isArray(collection['members'])
				? (collection['members'] as unknown[])
				: [];
			for (const member of members) {
				const ref = isRecord(member) ? member['ref'] : undefined;
				if (typeof ref === 'string' && !resolves(ref)) {
					const message = `${id}: member ref ${ref} is neither in the archive nor in errors.json`;
					error('dangling-ref', message, 'collections.json');
				}
			}
		}
		for (const start of parents.keys()) {
			const path = new Set<string>([start]);
			let cursor = parents.get(start);
			while (cursor !== undefined && !path.has(cursor)) {
				path.add(cursor);
				cursor = parents.get(cursor);
			}
			if (cursor === start) {
				error('collection-cycle', `${start} is its own ancestor via "parent"`, 'collections.json');
			}
		}
	}
	for (const { entry, id } of attachments) {
		if (!resolves(id)) {
			error('dangling-ref', `attachedTo ${id} is neither in the archive nor in errors.json`, entry);
		}
	}

	// ── §11 manifest bookkeeping ────────────────────────────────────────────────────────────
	if (manifestOk && isRecord(manifest)) {
		const contents = manifest['contents'] as Record<string, unknown>;
		const errors = manifest['errors'] as Record<string, unknown>;
		const selection = manifest['selection'] as Record<string, unknown>;
		for (const key of COUNT_KEYS) {
			if (contents[key] !== result.counts[key]) {
				const message = `manifest.contents.${key} is ${String(contents[key])} but the archive holds ${result.counts[key]}`;
				error('count-mismatch', message, 'manifest.json');
			}
			if (errorEntries !== null && errors[key] !== errorCounts[key]) {
				const message = `manifest.errors.${key} is ${String(errors[key])} but errors.json lists ${errorCounts[key]}`;
				error('count-mismatch', message, 'manifest.json');
			}
			if (selection[key] === 'excluded' && result.counts[key] + errorCounts[key] > 0) {
				warn(
					'selection-mismatch',
					`${key} are marked "excluded" but appear in the archive`,
					'manifest.json'
				);
			}
		}
		if (errorEntries !== null) {
			const expected = errorEntries === 0 ? 'complete' : 'partial';
			if (manifest['status'] !== expected) {
				const message = `status is "${String(manifest['status'])}" but errors.json has ${errorEntries} entries (expected "${expected}")`;
				error('status-mismatch', message, 'manifest.json');
			}
		}
		const part = manifest['part'] as Record<string, unknown>;
		if (Number(part['index']) > Number(part['of'])) {
			error('schema', 'part.index must not exceed part.of', 'manifest.json');
		} else if (part['of'] !== 1) {
			warn(
				'multi-part',
				'multi-part archives are reserved; 1.0 writers always write 1 of 1',
				'manifest.json'
			);
		}
		if (/[^\s"@]+@[^\s"@]+\.[A-Za-z]{2,}/.test(JSON.stringify(manifest))) {
			warn('manifest-email', 'the manifest appears to contain an e-mail address', 'manifest.json');
		}
	}

	// ── §2.3 compression advice (never a validity requirement) ──────────────────────────────
	for (const name of photoFiles.keys()) {
		const info = photoFiles.get(name)?.raw.info;
		if (info && info.compressionMethod !== 0) {
			warn('compression-advice', 'photos should be stored (method 0), not deflated', name);
		}
	}
}
