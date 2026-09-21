/**
 * Reference reader for Portable Map Archive 1.0-draft: prints the object tree
 * (collections → members → references → photo attachments). Follows "Reading an archive"
 * (spec §14) and nothing else; it assumes an archive that passes `pma-validate`.
 */
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

type Obj = Record<string, any>;

function open(path: string): Promise<ZipFile> {
	return new Promise((resolve, reject) =>
		yauzl.open(path, { lazyEntries: true, autoClose: false }, (e, zip) =>
			e ? reject(e) : resolve(zip)
		)
	);
}

function list(zip: ZipFile): Promise<Map<string, Entry>> {
	return new Promise((resolve, reject) => {
		const entries = new Map<string, Entry>();
		zip.on('entry', (entry: Entry) => (entries.set(entry.fileName, entry), zip.readEntry()));
		zip.on('end', () => resolve(entries));
		zip.on('error', reject); // includes unsafe entry names: yauzl refuses them
		zip.readEntry();
	});
}

function json(zip: ZipFile, entry: Entry): Promise<any> {
	return new Promise((resolve, reject) =>
		zip.openReadStream(entry, (err, stream) => {
			if (err) return reject(err);
			const chunks: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
		})
	);
}

export async function readArchiveTree(path: string): Promise<string> {
	const zip = await open(path);
	try {
		const entries = await list(zip);
		// Step 1: the manifest decides whether this is an archive we can read at all.
		const manifestEntry = entries.get('manifest.json');
		if (!manifestEntry) throw new Error('no manifest.json: aborted export');
		const manifest: Obj = await json(zip, manifestEntry);
		if (manifest.format !== 'portable-map-archive' || manifest.version !== 1)
			throw new Error(`unsupported archive: ${manifest.format} version ${manifest.version}`);

		// Step 2: index every object by archive-local ID. File names are never parsed.
		const objects = new Map<string, { name: string; where: string }>();
		const photos: Obj[] = [];
		for (const [name, entry] of entries) {
			const dir = name.split('/')[0];
			if (!name.endsWith('.json') || !['tracks', 'routes', 'photos'].includes(dir ?? '')) continue;
			const sidecar: Obj = await json(zip, entry);
			const where = `${dir}/${sidecar.file}`;
			if (dir === 'photos') photos.push({ ...sidecar, where });
			objects.set(sidecar.id, { name: sidecar.name ?? sidecar.caption ?? '', where });
		}
		for (const where of ['waypoints/waypoints.geojson', 'areas/areas.geojson']) {
			const entry = entries.get(where);
			for (const feature of entry ? (await json(zip, entry)).features : [])
				objects.set(feature.id, { name: feature.properties.name, where });
		}
		const collections: Obj[] = (await json(zip, entries.get('collections.json')!)).collections;
		for (const c of collections) objects.set(c.id, { name: c.name, where: 'collections.json' });
		const failed = new Map<string, string>();
		for (const e of await json(zip, entries.get('errors.json')!))
			if (e.id) failed.set(e.id, e.error);

		// Step 3: print.
		const out: string[] = [];
		const counts = (o: Obj) =>
			Object.entries(o)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ');
		out.push(
			`Portable Map Archive v${manifest.version} · ${manifest.source.platform} · ${manifest.status}`
		);
		out.push(
			`  created ${manifest.createdAt} by ${manifest.generator.name} ${manifest.generator.version}`
		);
		out.push(`  account: ${manifest.source.account.displayName}`);
		out.push(`  contents: ${counts(manifest.contents)}`, `  errors: ${counts(manifest.errors)}`);

		const label = (id: string) => `${id} ${JSON.stringify(objects.get(id)?.name ?? '')}`;
		const photoLine = (p: Obj) => `${label(p.id)} [${p.where}, ${p.contentType}, ${p.rendition}]`;
		const used = new Set<string>();
		const printPhotos = (id: string, pad: string) => {
			for (const p of photos.filter((p) => p.attachedTo === id))
				out.push(`${pad}+ photo: ${photoLine(p)}`);
		};
		const printObject = (id: string, pad: string) => {
			used.add(id);
			if (failed.has(id)) return void out.push(`${pad}${id} (failed to export: ${failed.get(id)})`);
			out.push(`${pad}${label(id)} [${objects.get(id)?.where}]`);
			printPhotos(id, pad + '  ');
		};
		const printCollection = (c: Obj, pad: string, seen: Set<string>) => {
			out.push(`${pad}${label(c.id)}`);
			printPhotos(c.id, pad + '  ');
			for (const m of c.members as Obj[]) {
				if (m.ref) printObject(m.ref, pad + '  ');
				else if (m.reference) {
					const { name, source, coordinate } = m.reference;
					const at = coordinate ? ` @ ${coordinate[0]},${coordinate[1]}` : '';
					out.push(`${pad}  → reference: ${name} <${source.url ?? source.id}>${at}`);
					const notes = Object.entries(m.annotations ?? {}).filter(([, v]) => v != null);
					if (notes.length)
						out.push(`${pad}      annotations: ${notes.map(([k, v]) => `${k}=${v}`).join(', ')}`);
				}
			}
			for (const child of collections.filter((x) => x.parent === c.id && !seen.has(x.id)))
				printCollection(child, pad + '  ', new Set(seen).add(child.id));
		};
		out.push('', 'Collections');
		for (const c of collections.filter((c) => !c.parent || failed.has(c.parent)))
			printCollection(c, '  ', new Set([c.id]));

		out.push('', 'Not in any collection');
		for (const [id] of objects)
			if (!used.has(id) && !/^(collection|photo)\//.test(id)) printObject(id, '  ');
		out.push('', 'Unattached photos');
		for (const p of photos.filter((p) => p.attachedTo === null || failed.has(p.attachedTo)))
			out.push(
				`  photo: ${photoLine(p)}${p.attachedTo ? ` (was attached to failed ${p.attachedTo})` : ''}`
			);
		return out.join('\n') + '\n';
	} finally {
		zip.close();
	}
}
