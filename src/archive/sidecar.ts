import type { LineRecord, PhotoRecord } from '../shared/models';
import type { LineSidecar, PhotoSidecar } from '../shared/schemas';
import type { FeatureSource } from './geojson';

export function lineSidecar(args: {
	id: string;
	file: string;
	record: LineRecord;
	geometrySource: 'native-gpx' | 'serialized';
	pointCount: number;
	source: FeatureSource;
}): LineSidecar {
	const { record } = args;
	return {
		id: args.id,
		kind: record.kind,
		file: args.file,
		geometrySource: args.geometrySource,
		name: record.name,
		description: record.description,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		activityType: record.activityType,
		visibility: record.visibility,
		tags: record.tags,
		stats: {
			distanceMeters: record.stats.distanceMeters,
			ascentMeters: record.stats.ascentMeters,
			durationSeconds: record.stats.durationSeconds,
			pointCount: args.pointCount
		},
		source: args.source
	};
}

export function photoSidecar(args: {
	id: string;
	file: string;
	contentType: string;
	record: PhotoRecord;
	attachedTo: string | null;
	source: FeatureSource;
}): PhotoSidecar {
	const { record } = args;
	return {
		id: args.id,
		file: args.file,
		contentType: args.contentType,
		rendition: record.rendition,
		attachedTo: args.attachedTo,
		name: record.name,
		caption: record.caption,
		takenAt: record.takenAt,
		uploadedAt: record.uploadedAt,
		coordinate: record.coordinate,
		source: args.source
	};
}
