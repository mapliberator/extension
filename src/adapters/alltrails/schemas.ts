/**
 * AllTrails response schemas. Everything platform-specific stays inside this directory
 * (PRD §6.5). Objects are loose: unknown extra fields are not drift.
 */
import { z } from 'zod';

export const AllTrailsMeSchema = z.looseObject({
	user: z.looseObject({
		id: z.number(),
		firstName: z.string().nullable().optional(),
		lastName: z.string().nullable().optional(),
		slug: z.string().nullable().optional()
	})
});

export const AllTrailsStatsSchema = z.looseObject({
	activities: z.number().optional(),
	maps: z.number().optional(),
	photos: z.number().optional(),
	completed: z.number().optional()
});

const LocationSchema = z.looseObject({ latitude: z.number(), longitude: z.number() });
const UserRefSchema = z.looseObject({ id: z.number() });

const lineCommon = {
	id: z.number(),
	name: z.string().nullable(),
	createdAt: z.number().nullable().optional(),
	updatedAt: z.number().nullable().optional(),
	activityType: z.looseObject({ uid: z.string() }).nullable().optional(),
	private: z.boolean().optional(),
	user: UserRefSchema,
	summaryStats: z
		.looseObject({
			distanceTotal: z.number().nullable().optional(),
			elevationGain: z.number().nullable().optional(),
			timeTotal: z.number().nullable().optional()
		})
		.nullable()
		.optional(),
	location: LocationSchema.nullable().optional()
};

export const AllTrailsActivitySchema = z.looseObject({
	...lineCommon,
	notes: z.string().nullable().optional()
});
export type AllTrailsActivity = z.infer<typeof AllTrailsActivitySchema>;

export const AllTrailsMapWaypointSchema = z.looseObject({
	id: z.number(),
	name: z.string().nullable(),
	description: z.string().nullable().optional(),
	location: LocationSchema,
	createdAt: z.number().nullable().optional()
});
export type AllTrailsMapWaypoint = z.infer<typeof AllTrailsMapWaypointSchema>;

export const AllTrailsMapSchema = z.looseObject({
	...lineCommon,
	description: z.string().nullable().optional(),
	waypoints: z.array(AllTrailsMapWaypointSchema).default([])
});
export type AllTrailsMap = z.infer<typeof AllTrailsMapSchema>;

export const AllTrailsSegmentsSchema = z.looseObject({
	id: z.number(),
	segments: z.array(
		z.looseObject({
			polyline: z.looseObject({
				pointsData: z.string(),
				elevationData: z.array(z.number().nullable()).nullable().optional(),
				timeData: z.array(z.number().nullable()).nullable().optional()
			})
		})
	)
});
export type AllTrailsSegments = z.infer<typeof AllTrailsSegmentsSchema>;

/** Platform-owned trail. Only the fields a reference may carry are even parsed. */
export const AllTrailsTrailSchema = z.looseObject({
	id: z.number(),
	name: z.string(),
	slug: z.string().nullable().optional(),
	location: LocationSchema.nullable().optional()
});
export type AllTrailsTrail = z.infer<typeof AllTrailsTrailSchema>;

export const AllTrailsListItemSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('trail'), trail: AllTrailsTrailSchema }),
	z.looseObject({ type: z.literal('map'), id: z.number() }),
	z.looseObject({ type: z.literal('activity'), id: z.number() })
]);

export const AllTrailsListSchema = z.looseObject({
	id: z.number(),
	name: z.string().nullable(),
	description: z.string().nullable().optional(),
	private: z.boolean().optional(),
	createdAt: z.number().nullable().optional(),
	updatedAt: z.number().nullable().optional(),
	user: UserRefSchema,
	items: z.array(AllTrailsListItemSchema).default([])
});
export type AllTrailsList = z.infer<typeof AllTrailsListSchema>;

export const AllTrailsCompletedSchema = z.looseObject({
	trail: AllTrailsTrailSchema,
	completedAt: z.string().nullable().optional(),
	rating: z.number().nullable().optional(),
	review: z.string().nullable().optional(),
	privateNotes: z.string().nullable().optional()
});
export type AllTrailsCompleted = z.infer<typeof AllTrailsCompletedSchema>;

export const AllTrailsPhotoSchema = z.looseObject({
	id: z.number(),
	title: z.string().nullable().optional(),
	caption: z.string().nullable().optional(),
	createdAt: z.number().nullable().optional(),
	takenAt: z.number().nullable().optional(),
	user: UserRefSchema,
	location: LocationSchema.nullable().optional(),
	urls: z.looseObject({ original: z.string().optional(), large: z.string() }),
	attachedTo: z
		.looseObject({ type: z.enum(['activity', 'map', 'trail']), id: z.number() })
		.nullable()
		.optional()
});
export type AllTrailsPhoto = z.infer<typeof AllTrailsPhotoSchema>;

export function allTrailsListingSchema<S extends z.ZodType>(item: S) {
	return z.looseObject({
		items: z.array(item),
		meta: z.looseObject({ nextCursor: z.string().nullable() })
	});
}
