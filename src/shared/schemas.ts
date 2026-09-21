/**
 * zod schemas for every JSON document inside a Portable Map Archive.
 *
 * These are the source of truth for the JSON Schemas in `spec/schemas/` (see
 * `scripts/generate-spec-schemas.ts`). Objects are loose on purpose: within a major version,
 * readers must ignore unknown fields (PRD §8.11).
 */
import { z } from 'zod';

export const FORMAT_NAME = 'portable-map-archive';
export const FORMAT_VERSION = 1;

export const OBJECT_TYPES = ['track', 'route', 'waypoint', 'area', 'photo', 'collection'] as const;
export const ObjectTypeSchema = z.enum(OBJECT_TYPES);
export type ObjectType = z.infer<typeof ObjectTypeSchema>;

/** Plural keys used by manifest `selection`, `contents` and `errors`. */
export const PLURAL = {
	track: 'tracks',
	route: 'routes',
	waypoint: 'waypoints',
	area: 'areas',
	photo: 'photos',
	collection: 'collections'
} as const satisfies Record<ObjectType, string>;

const archiveId = (type: string) =>
	z
		.string()
		.regex(new RegExp(`^${type}/[0-9]{6,}$`))
		.describe(`Archive-local ID: "${type}/<sequence>"`);

export const ArchiveIdSchema = z
	.string()
	.regex(/^(track|route|waypoint|area|photo|collection)\/[0-9]{6,}$/)
	.describe('Archive-local ID: "<type>/<sequence>"');

/** RFC 3339 timestamp in UTC, e.g. 2025-01-18T03:40:51Z */
export const TimestampSchema = z
	.string()
	.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/)
	.describe('RFC 3339 timestamp, UTC');

export const DateOrTimestampSchema = z
	.string()
	.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z)?$/)
	.describe('RFC 3339 full-date or UTC timestamp');

/** A sibling file name: no directories, ever. */
export const FileNameSchema = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
	.describe('Name of a file in the same directory as this sidecar');

export const PositionSchema = z
	.array(z.number())
	.min(2)
	.max(3)
	.describe('[longitude, latitude, elevationMeters?] in WGS84 (RFC 7946 order)');

export const SourceSchema = z.looseObject({
	platform: z.string().min(1),
	id: z.string(),
	url: z.string().nullable().optional(),
	raw: z.unknown().optional().describe('Scrubbed source representation; only when requested')
});

export const VisibilitySchema = z.enum(['private', 'unlisted', 'public']).nullable();

const commonProperties = {
	name: z.string(),
	description: z.string().nullable().optional(),
	createdAt: TimestampSchema.nullable().optional(),
	updatedAt: TimestampSchema.nullable().optional(),
	visibility: VisibilitySchema.optional(),
	tags: z.array(z.string()).optional(),
	source: SourceSchema
};

export const LineStatsSchema = z.looseObject({
	distanceMeters: z.number().nonnegative().nullable().optional(),
	ascentMeters: z.number().nullable().optional(),
	durationSeconds: z.number().nonnegative().nullable().optional(),
	pointCount: z.number().int().nonnegative()
});

export const LineSidecarSchema = z
	.looseObject({
		id: z.string().regex(/^(track|route)\/[0-9]{6,}$/),
		kind: z.enum(['track', 'route']),
		file: FileNameSchema,
		geometrySource: z.enum(['native-gpx', 'serialized']),
		...commonProperties,
		activityType: z.string().nullable().optional(),
		stats: LineStatsSchema,
		sha256: z.string().optional().describe('Reserved for a future 1.x; not written by 1.0')
	})
	.describe('Sidecar adjacent to a track or route GPX file');
export type LineSidecar = z.infer<typeof LineSidecarSchema>;

export const PhotoSidecarSchema = z
	.looseObject({
		id: archiveId('photo'),
		file: FileNameSchema,
		contentType: z.string(),
		rendition: z.enum(['original', 'largest-available']),
		attachedTo: ArchiveIdSchema.nullable(),
		name: z.string().nullable().optional(),
		caption: z.string().nullable().optional(),
		takenAt: TimestampSchema.nullable().optional(),
		uploadedAt: TimestampSchema.nullable().optional(),
		coordinate: PositionSchema.nullable().optional(),
		source: SourceSchema,
		sha256: z.string().optional().describe('Reserved for a future 1.x; not written by 1.0')
	})
	.describe('Sidecar adjacent to a photo');
export type PhotoSidecar = z.infer<typeof PhotoSidecarSchema>;

export const WaypointFeatureSchema = z.looseObject({
	type: z.literal('Feature'),
	id: archiveId('waypoint'),
	geometry: z.looseObject({ type: z.literal('Point'), coordinates: PositionSchema }),
	properties: z.looseObject({
		...commonProperties,
		icon: z.string().nullable().optional()
	})
});
export type WaypointFeature = z.infer<typeof WaypointFeatureSchema>;

export const WaypointCollectionSchema = z
	.looseObject({
		type: z.literal('FeatureCollection'),
		features: z.array(WaypointFeatureSchema)
	})
	.describe('waypoints/waypoints.geojson');

const LinearRingSchema = z.array(PositionSchema).min(4);

export const AreaFeatureSchema = z.looseObject({
	type: z.literal('Feature'),
	id: archiveId('area'),
	geometry: z.union([
		z.looseObject({ type: z.literal('Polygon'), coordinates: z.array(LinearRingSchema).min(1) }),
		z.looseObject({
			type: z.literal('MultiPolygon'),
			coordinates: z.array(z.array(LinearRingSchema).min(1)).min(1)
		})
	]),
	properties: z.looseObject({
		...commonProperties,
		areaSquareMeters: z.number().nonnegative().nullable().optional()
	})
});
export type AreaFeature = z.infer<typeof AreaFeatureSchema>;

export const AreaCollectionSchema = z
	.looseObject({
		type: z.literal('FeatureCollection'),
		features: z.array(AreaFeatureSchema)
	})
	.describe('areas/areas.geojson');

export const AnnotationsSchema = z
	.looseObject({
		completedAt: DateOrTimestampSchema.nullable().optional(),
		rating: z.number().nullable().optional(),
		review: z.string().nullable().optional(),
		notes: z.string().nullable().optional()
	})
	.describe("The user's own annotations on third-party content");

export const ReferenceSchema = z
	.looseObject({
		name: z.string(),
		source: z.looseObject({
			platform: z.string().min(1),
			id: z.string(),
			url: z.string().nullable().optional()
		}),
		coordinate: PositionSchema.nullable().optional()
	})
	.describe('Pointer to content the user saved but did not author. Never carries geometry.');

export const MemberSchema = z.union([
	z.looseObject({ ref: ArchiveIdSchema }),
	z.looseObject({ reference: ReferenceSchema, annotations: AnnotationsSchema.optional() })
]);
export type Member = z.infer<typeof MemberSchema>;

export const CollectionSchema = z.looseObject({
	id: archiveId('collection'),
	name: z.string(),
	description: z.string().nullable().optional(),
	parent: archiveId('collection').nullable().optional(),
	createdAt: TimestampSchema.nullable().optional(),
	updatedAt: TimestampSchema.nullable().optional(),
	source: z
		.looseObject({
			platform: z.string().optional(),
			id: z.string(),
			url: z.string().nullable().optional(),
			raw: z.unknown().optional()
		})
		.nullable()
		.optional()
		.describe('null for collections synthesized by the exporter (e.g. "Completed trails")'),
	members: z.array(MemberSchema)
});
export type Collection = z.infer<typeof CollectionSchema>;

export const CollectionsFileSchema = z
	.looseObject({ collections: z.array(CollectionSchema) })
	.describe('collections.json');
export type CollectionsFile = z.infer<typeof CollectionsFileSchema>;

export const ErrorEntrySchema = z.looseObject({
	type: ObjectTypeSchema,
	id: ArchiveIdSchema.nullable().describe('Archive-local ID the object would have had'),
	sourceId: z.string().nullable(),
	adapter: z.string().describe('"<adapter id>@<adapter version>"'),
	error: z.string()
});
export type ErrorEntry = z.infer<typeof ErrorEntrySchema>;

export const ErrorsFileSchema = z.array(ErrorEntrySchema).describe('errors.json');

const countsShape = {
	routes: z.number().int().nonnegative(),
	tracks: z.number().int().nonnegative(),
	waypoints: z.number().int().nonnegative(),
	areas: z.number().int().nonnegative(),
	collections: z.number().int().nonnegative(),
	photos: z.number().int().nonnegative()
};
export const CountsSchema = z.looseObject(countsShape);
export type Counts = z.infer<typeof CountsSchema>;

const SelectionValueSchema = z.enum(['included', 'excluded']);
export const SelectionSchema = z.looseObject({
	routes: SelectionValueSchema,
	tracks: SelectionValueSchema,
	waypoints: SelectionValueSchema,
	areas: SelectionValueSchema,
	collections: SelectionValueSchema,
	photos: SelectionValueSchema,
	rawSourceData: z.boolean()
});
export type ManifestSelection = z.infer<typeof SelectionSchema>;

export const ManifestSchema = z
	.looseObject({
		format: z.literal(FORMAT_NAME),
		version: z.literal(FORMAT_VERSION),
		createdAt: TimestampSchema,
		status: z.enum(['complete', 'partial']),
		part: z
			.looseObject({ index: z.number().int().min(1), of: z.number().int().min(1) })
			.describe('Reserved for multi-part archives; 1.0 always writes { index: 1, of: 1 }'),
		generator: z.looseObject({
			name: z.string(),
			version: z.string(),
			browser: z.string().optional()
		}),
		source: z.looseObject({
			platform: z.string().min(1),
			adapterVersion: z.string(),
			account: z.looseObject({ id: z.string(), displayName: z.string() })
		}),
		selection: SelectionSchema,
		contents: CountsSchema,
		errors: CountsSchema
	})
	.describe('manifest.json — always the last entry of the archive');
export type Manifest = z.infer<typeof ManifestSchema>;

/** Documents published as JSON Schema in `spec/schemas/<key>.schema.json`. */
export const SPEC_SCHEMAS = {
	manifest: ManifestSchema,
	'line-sidecar': LineSidecarSchema,
	'photo-sidecar': PhotoSidecarSchema,
	waypoints: WaypointCollectionSchema,
	areas: AreaCollectionSchema,
	collections: CollectionsFileSchema,
	errors: ErrorsFileSchema
} as const;
