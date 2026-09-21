/**
 * Gaia GPS response schemas. Everything platform-specific — endpoints, field names — stays inside
 * this directory (PRD §6.5). Objects are loose: unknown extra fields are not drift.
 */
import { z } from 'zod';

export const GaiaUserSchema = z.looseObject({
	id: z.string(),
	display_name: z.string()
});

const common = {
	id: z.string(),
	title: z.string().nullable(),
	notes: z.string().nullable().optional(),
	time_created: z.string().nullable(),
	updated_date: z.string().nullable().optional(),
	public: z.boolean().optional(),
	user_id: z.string(),
	tags: z.array(z.string()).optional()
};

const LocationSchema = z.looseObject({ latitude: z.number(), longitude: z.number() });

export const GaiaTrackSummarySchema = z.looseObject({
	...common,
	activities: z.array(z.string()).optional(),
	distance: z.number().nullable().optional(),
	total_ascent: z.number().nullable().optional(),
	total_time: z.number().nullable().optional(),
	start_location: LocationSchema.nullable().optional()
});
export type GaiaTrackSummary = z.infer<typeof GaiaTrackSummarySchema>;

export const GaiaRouteSummarySchema = GaiaTrackSummarySchema;
export type GaiaRouteSummary = GaiaTrackSummary;

/** [lon, lat, ele?, epochSeconds?] */
const LineCoordinateSchema = z.array(z.number().nullable()).min(2);

export const GaiaLineDetailSchema = z.looseObject({
	id: z.string(),
	geometry: z.looseObject({
		type: z.literal('MultiLineString'),
		coordinates: z.array(z.array(LineCoordinateSchema))
	})
});
export type GaiaLineDetail = z.infer<typeof GaiaLineDetailSchema>;

export const GaiaWaypointSchema = z.looseObject({
	...common,
	icon: z.string().nullable().optional(),
	geometry: z.looseObject({
		type: z.literal('Point'),
		coordinates: z.array(z.number()).min(2).max(3)
	})
});
export type GaiaWaypoint = z.infer<typeof GaiaWaypointSchema>;

export const GaiaAreaSchema = z.looseObject({
	...common,
	area: z.number().nullable().optional(),
	geometry: z.union([
		z.looseObject({
			type: z.literal('Polygon'),
			coordinates: z.array(z.array(z.array(z.number()).min(2)))
		}),
		z.looseObject({
			type: z.literal('MultiPolygon'),
			coordinates: z.array(z.array(z.array(z.array(z.number()).min(2))))
		})
	])
});
export type GaiaArea = z.infer<typeof GaiaAreaSchema>;

export const GaiaPhotoSchema = z.looseObject({
	...common,
	caption: z.string().nullable().optional(),
	taken_at: z.string().nullable().optional(),
	latitude: z.number().nullable().optional(),
	longitude: z.number().nullable().optional(),
	fullsize_url: z.string(),
	attached_to: z
		.looseObject({ type: z.enum(['track', 'route', 'waypoint', 'area']), id: z.string() })
		.nullable()
		.optional()
});
export type GaiaPhoto = z.infer<typeof GaiaPhotoSchema>;

export const GaiaSavedHikeSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	url: z.string().nullable().optional(),
	trailhead: LocationSchema.nullable().optional(),
	user_notes: z.string().nullable().optional(),
	completed_on: z.string().nullable().optional(),
	user_rating: z.number().nullable().optional()
});
export type GaiaSavedHike = z.infer<typeof GaiaSavedHikeSchema>;

export const GaiaFolderSchema = z.looseObject({
	id: z.string(),
	name: z.string().nullable(),
	notes: z.string().nullable().optional(),
	parent: z.string().nullable().optional(),
	time_created: z.string().nullable().optional(),
	updated_date: z.string().nullable().optional(),
	user_id: z.string(),
	tracks: z.array(z.string()).default([]),
	routes: z.array(z.string()).default([]),
	waypoints: z.array(z.string()).default([]),
	areas: z.array(z.string()).default([]),
	saved_hikes: z.array(GaiaSavedHikeSchema).default([])
});
export type GaiaFolder = z.infer<typeof GaiaFolderSchema>;

export function gaiaListingSchema<S extends z.ZodType>(item: S) {
	return z.looseObject({
		count: z.number().int().nonnegative(),
		next: z.string().nullable(),
		results: z.array(item)
	});
}
