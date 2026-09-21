/**
 * Gaia GPS response schemas, written against the recorded shapes in docs/phase0-findings.md.
 * Everything platform-specific — endpoints, field names — stays inside this directory (PRD §6.5).
 * Objects are loose: unknown extra fields are not drift.
 */
import { z } from 'zod';

/** `GET /api/v3/user/` answers 200 for anonymous visitors too; `is_authenticated` tells them apart. */
export const GaiaUserSchema = z.looseObject({
	id: z.number().nullable(),
	display_name: z.string().nullable().optional(),
	username: z.string().nullable().optional(),
	is_authenticated: z.boolean()
});

/** Listings are the whole collection as one bare array, soft-deleted objects included. */
export function gaiaListingSchema<S extends z.ZodType>(item: S) {
	return z.array(item);
}

const common = {
	id: z.string(),
	deleted: z.boolean().optional(),
	title: z.string().nullable(),
	notes: z.string().nullable().optional(),
	time_created: z.string().nullable(),
	updated_date: z.string().nullable().optional(),
	public: z.boolean().optional()
};

export const GaiaTrackSummarySchema = z.looseObject({
	...common,
	activities: z.array(z.string()).optional(),
	distance: z.number().nullable().optional(),
	total_ascent: z.number().nullable().optional(),
	total_time: z.number().nullable().optional()
});
export type GaiaTrackSummary = z.infer<typeof GaiaTrackSummarySchema>;

export const GaiaRouteSummarySchema = GaiaTrackSummarySchema;
export type GaiaRouteSummary = GaiaTrackSummary;

/** [lon, lat, ele?, epochSeconds?] — routes carry 0 in the time slot. */
const LineCoordinateSchema = z.array(z.number().nullable()).min(2);

/** `GET /api/objects/<track|route>/<id>/`: a FeatureCollection holding the one line. */
export const GaiaLineDetailSchema = z.looseObject({
	features: z
		.array(
			z.looseObject({
				properties: z.looseObject({
					user_id: z.number().nullable().optional(),
					latitude: z.number().nullable().optional(),
					longitude: z.number().nullable().optional()
				}),
				geometry: z.looseObject({
					type: z.literal('MultiLineString'),
					coordinates: z.array(z.array(LineCoordinateSchema))
				})
			})
		)
		.min(1)
});
export type GaiaLineDetail = z.infer<typeof GaiaLineDetailSchema>;

/** The listing gives each coordinate as a one-element array; accept a plain number as well. */
const ListedCoordinateSchema = z.union([z.number(), z.array(z.number()).min(1)]);

export const GaiaWaypointSchema = z.looseObject({
	...common,
	icon: z.string().nullable().optional(),
	latitude: ListedCoordinateSchema,
	longitude: ListedCoordinateSchema
});
export type GaiaWaypoint = z.infer<typeof GaiaWaypointSchema>;

/** Listed like a track (with the line fields zeroed); the polygon is only in the detail. */
export const GaiaAreaSummarySchema = z.looseObject({ ...common });
export type GaiaAreaSummary = z.infer<typeof GaiaAreaSummarySchema>;

const PolygonSchema = z.union([
	z.looseObject({
		type: z.literal('Polygon'),
		coordinates: z.array(z.array(z.array(z.number()).min(2)))
	}),
	z.looseObject({
		type: z.literal('MultiPolygon'),
		coordinates: z.array(z.array(z.array(z.array(z.number()).min(2))))
	})
]);

const AreaFeatureSchema = z.looseObject({
	properties: z.looseObject({ user_id: z.number().nullable().optional() }).optional(),
	geometry: PolygonSchema
});

/**
 * A FeatureCollection holding the one polygon Feature, as recorded; a bare Feature is accepted
 * too. Yields the Feature.
 */
export const GaiaAreaDetailSchema = z
	.union([
		z.looseObject({ features: z.array(AreaFeatureSchema).min(1) }).transform((c) => c.features[0]!),
		AreaFeatureSchema
	])
	.transform((feature): z.infer<typeof AreaFeatureSchema> => feature);
export type GaiaAreaDetail = z.infer<typeof GaiaAreaDetailSchema>;

export const GaiaPhotoSchema = z.looseObject({
	...common,
	waypoint_id: z.string().nullable().optional()
});
export type GaiaPhoto = z.infer<typeof GaiaPhotoSchema>;

export const GaiaFolderSchema = z.looseObject({
	id: z.string(),
	deleted: z.boolean().optional(),
	title: z.string().nullable(),
	notes: z.string().nullable().optional(),
	parent: z.string().nullable().optional(),
	time_created: z.string().nullable().optional(),
	updated_date: z.string().nullable().optional(),
	is_shared: z.boolean().optional(),
	access: z.string().nullable().optional(),
	tracks: z.array(z.string()).default([]),
	routes: z.array(z.string()).default([]),
	waypoints: z.array(z.string()).default([]),
	areas: z.array(z.string()).default([])
});
export type GaiaFolder = z.infer<typeof GaiaFolderSchema>;
