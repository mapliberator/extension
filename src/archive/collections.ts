/**
 * Resolves adapter collection records into `collections.json`: source IDs become archive-local
 * IDs, saved third-party content becomes `reference` members (PRD §8.6).
 */
import type { CollectionRecord, ObjectType } from '../shared/models';
import type { Collection, CollectionsFile, Member } from '../shared/schemas';
import { archiveId } from './filenames';
import type { FeatureSource } from './geojson';

export interface IdLookup {
	/** Archive ID of an exported object, or of one that failed and is listed in errors.json. */
	resolve(type: ObjectType, sourceId: string): string | null;
}

export function buildCollections(args: {
	records: CollectionRecord[];
	platform: string;
	lookup: IdLookup;
	sourceFor(record: CollectionRecord): FeatureSource | null;
}): CollectionsFile {
	const { records, platform, lookup } = args;
	const idByKey = new Map<string, string>();
	records.forEach((record, index) => idByKey.set(record.key, archiveId('collection', index + 1)));

	const collections: Collection[] = records.map((record, index) => {
		const id = archiveId('collection', index + 1);
		const seen = new Set<string>();
		const members: Member[] = [];
		for (const member of record.members) {
			if (member.kind === 'object') {
				const ref = lookup.resolve(member.type, member.sourceId);
				if (!ref || seen.has(ref)) continue;
				seen.add(ref);
				members.push({ ref });
			} else {
				const { reference } = member;
				const annotations = cleanAnnotations(reference.annotations);
				members.push({
					reference: {
						name: reference.name,
						source: { platform, id: reference.source.id, url: reference.source.url },
						coordinate: reference.coordinate
					},
					...(annotations ? { annotations } : {})
				});
			}
		}
		const parent = record.parentSourceId ? (idByKey.get(record.parentSourceId) ?? null) : null;
		return {
			id,
			name: record.name,
			description: record.description,
			parent: parent === id ? null : parent,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			source: args.sourceFor(record),
			members
		};
	});
	return { collections };
}

function cleanAnnotations(
	annotations: Record<string, unknown> | undefined
): Record<string, unknown> | null {
	if (!annotations) return null;
	const entries = Object.entries(annotations).filter(
		([, value]) => value !== null && value !== undefined && value !== ''
	);
	return entries.length ? Object.fromEntries(entries) : null;
}
