import type { ExportSelection, UserInfo } from '../shared/models';
import {
	FORMAT_NAME,
	FORMAT_VERSION,
	type Counts,
	type Manifest,
	type ManifestSelection
} from '../shared/schemas';

export const GENERATOR_NAME = 'MapLiberator';

export function emptyCounts(): Counts {
	return { routes: 0, tracks: 0, waypoints: 0, areas: 0, collections: 0, photos: 0 };
}

export function manifestSelection(selection: ExportSelection): ManifestSelection {
	const flag = (included: boolean) => (included ? 'included' : 'excluded');
	return {
		routes: flag(selection.routes),
		tracks: flag(selection.tracks),
		waypoints: flag(selection.waypoints),
		areas: flag(selection.areas),
		collections: flag(selection.collections),
		photos: flag(selection.photos),
		rawSourceData: selection.rawSourceData
	};
}

/** RFC 3339 UTC without milliseconds. */
export function toTimestamp(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildManifest(args: {
	createdAt: Date;
	generatorVersion: string;
	browser: string;
	platform: string;
	adapterVersion: string;
	account: UserInfo;
	selection: ExportSelection;
	contents: Counts;
	errors: Counts;
}): Manifest {
	const errorTotal = Object.values(args.errors).reduce<number>(
		(sum, value) => sum + (typeof value === 'number' ? value : 0),
		0
	);
	return {
		format: FORMAT_NAME,
		version: FORMAT_VERSION,
		createdAt: toTimestamp(args.createdAt),
		status: errorTotal === 0 ? 'complete' : 'partial',
		part: { index: 1, of: 1 },
		generator: { name: GENERATOR_NAME, version: args.generatorVersion, browser: args.browser },
		source: {
			platform: args.platform,
			adapterVersion: args.adapterVersion,
			// Display name only. Never the e-mail address (PRD §8.8).
			account: { id: args.account.id, displayName: args.account.displayName }
		},
		selection: manifestSelection(args.selection),
		contents: args.contents,
		errors: args.errors
	};
}

export function defaultArchiveFilename(platform: string, date: Date): string {
	const day = [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0')
	].join('-');
	return `mapliberator-${platform}-${day}.zip`;
}
