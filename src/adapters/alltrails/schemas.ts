/**
 * AllTrails response schemas, written against the recorded shapes in docs/phase0-findings.md.
 * Everything platform-specific stays inside this directory (PRD §6.5). Objects are loose:
 * unknown extra fields are not drift.
 */
import { z } from 'zod';

const UserRefSchema = z.looseObject({ id: z.number() });

export const AllTrailsMeSchema = z.looseObject({
	users: z
		.array(
			z.looseObject({
				id: z.number(),
				firstName: z.string().nullable().optional(),
				lastName: z.string().nullable().optional(),
				tracks: z.number().nullable().optional(),
				maps: z.number().nullable().optional(),
				photos: z.number().nullable().optional()
			})
		)
		.min(1)
});

/** Every listing is `{ <resource>: [...], pageInfo }`, paged with `after=<pageInfo.nextCursor>`. */
const pageInfo = z
	.looseObject({
		hasNextPage: z.boolean().nullable().optional(),
		nextCursor: z.string().nullable().optional()
	})
	.nullable()
	.optional();

/** A recording (`presentationType: 'track'`) or a custom route (`'map'`), as listed. */
export const AllTrailsMapSchema = z.looseObject({
	id: z.number(),
	name: z.string().nullable(),
	description: z.string().nullable().optional(),
	presentationType: z.string().optional(),
	slug: z.string().nullable().optional(),
	created_at: z.string().nullable().optional(),
	activity: z.looseObject({ uid: z.string().nullable().optional() }).nullable().optional(),
	private: z.boolean().nullable().optional(),
	user: UserRefSchema,
	photoCount: z.number().nullable().optional(),
	summaryStats: z
		.looseObject({
			duration: z.number().nullable().optional(),
			distanceTotal: z.number().nullable().optional(),
			elevationGain: z.number().nullable().optional()
		})
		.nullable()
		.optional(),
	metadata: z
		.looseObject({
			created: z.string().nullable().optional(),
			updated: z.string().nullable().optional()
		})
		.nullable()
		.optional()
});
export type AllTrailsMap = z.infer<typeof AllTrailsMapSchema>;
export const AllTrailsMapsPageSchema = z.looseObject({
	maps: z.array(AllTrailsMapSchema),
	pageInfo
});

const PolylineSchema = z.looseObject({
	pointsData: z.string(),
	indexedElevationData: z.string().nullable().optional(),
	indexedTimeData: z.string().nullable().optional()
});

const SegmentSchema = z.looseObject({
	sequence_num: z.number().nullable().optional(),
	dateTimeStart: z.string().nullable().optional(),
	polyline: PolylineSchema
});
export type AllTrailsSegment = z.infer<typeof SegmentSchema>;

export const AllTrailsWaypointSchema = z.looseObject({
	id: z.number(),
	name: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	location: z.looseObject({ latitude: z.number(), longitude: z.number() }),
	waypointCategory: z.looseObject({ uid: z.string().nullable().optional() }).nullable().optional()
});
export type AllTrailsWaypoint = z.infer<typeof AllTrailsWaypointSchema>;

/** `GET /maps/<id>?detail=deep` → `{ maps: [detail] }`. */
export const AllTrailsMapDetailSchema = z.looseObject({
	maps: z
		.array(
			z.looseObject({
				id: z.number(),
				routes: z
					.array(z.looseObject({ lineSegments: z.array(SegmentSchema).default([]) }))
					.nullable()
					.optional(),
				tracks: z
					.array(z.looseObject({ lineTimedSegments: z.array(SegmentSchema).default([]) }))
					.nullable()
					.optional(),
				waypoints: z.array(AllTrailsWaypointSchema).nullable().optional(),
				mapPhotos: z
					.array(z.looseObject({ photo: z.looseObject({ id: z.number() }) }))
					.nullable()
					.optional()
			})
		)
		.min(1)
});
export type AllTrailsMapDetail = z.infer<typeof AllTrailsMapDetailSchema>['maps'][number];

export const AllTrailsListSchema = z.looseObject({
	id: z.number(),
	name: z.string().nullable(),
	description: z.string().nullable().optional(),
	private: z.boolean().nullable().optional(),
	ownerId: z.number().nullable().optional(),
	user: UserRefSchema.nullable().optional()
});
export type AllTrailsList = z.infer<typeof AllTrailsListSchema>;
export const AllTrailsListsPageSchema = z.looseObject({
	lists: z.array(AllTrailsListSchema),
	pageInfo
});

/** An item carries nothing but ids. Only `type: 'trail'` has been observed. */
export const AllTrailsListItemSchema = z.looseObject({
	id: z.number(),
	type: z.string(),
	notes: z.string().nullable().optional(),
	trailId: z.number().nullable().optional()
});
export type AllTrailsListItem = z.infer<typeof AllTrailsListItemSchema>;

export const AllTrailsListItemsSchema = z.looseObject({
	listItems: z.array(AllTrailsListItemSchema)
});

/** Only what a reference may keep: everything else on a trail is the platform's content. */
export const AllTrailsTrailSchema = z.looseObject({
	trails: z
		.array(
			z.looseObject({
				id: z.number(),
				name: z.string(),
				slug: z.string().nullable().optional(),
				location: z
					.looseObject({
						latitude: z.number().nullable().optional(),
						longitude: z.number().nullable().optional()
					})
					.nullable()
					.optional()
			})
		)
		.min(1)
});
export type AllTrailsTrail = z.infer<typeof AllTrailsTrailSchema>['trails'][number];

export const AllTrailsPhotoSchema = z.looseObject({
	id: z.number(),
	title: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	location: z
		.looseObject({
			latitude: z.number().nullable().optional(),
			longitude: z.number().nullable().optional()
		})
		.nullable()
		.optional(),
	user: UserRefSchema,
	metadata: z.looseObject({ created: z.string().nullable().optional() }).nullable().optional()
});
export type AllTrailsPhoto = z.infer<typeof AllTrailsPhotoSchema>;
export const AllTrailsPhotosPageSchema = z.looseObject({
	photos: z.array(AllTrailsPhotoSchema),
	pageInfo
});
