/**
 * Strava response schemas, written against the recorded shapes in docs/phase0-findings.md.
 * Everything platform-specific stays inside this directory (PRD §6.5). Objects are loose:
 * unknown extra fields are not drift.
 */
import { z } from 'zod';

const nullableNumber = z.number().nullable().optional();

/** `GET /frontend/athletes/current`. Signed out, `currentAthlete` is null. */
export const StravaCurrentAthleteSchema = z.looseObject({
	currentAthlete: z.looseObject({
		id: z.number(),
		firstname: z.string().nullable().optional(),
		lastname: z.string().nullable().optional()
	})
});
export type StravaAthlete = z.infer<typeof StravaCurrentAthleteSchema>['currentAthlete'];

/** One of the user's own activities, as `GET /athlete/training_activities` lists it. */
export const StravaActivitySchema = z.looseObject({
	id: z.number(),
	/** The same id as a string. Route ids have outgrown a double; activity ids may too. */
	id_str: z.string().optional(),
	name: z.string().nullable(),
	description: z.string().nullable().optional(),
	sport_type: z.string().nullable().optional(),
	private: z.boolean().nullable().optional(),
	visibility: z.string().nullable().optional(),
	/** UTC, as `YYYY-MM-DDTHH:MM:SS+0000`. */
	start_time: z.string().nullable().optional(),
	/** False for indoor sessions: no GPS, so nothing to put on a map. */
	has_latlng: z.boolean(),
	distance_raw: nullableNumber,
	elapsed_time_raw: nullableNumber,
	elevation_gain_raw: nullableNumber
});
export type StravaActivity = z.infer<typeof StravaActivitySchema>;

/** Paged with `page=`; `per_page` is capped at 20 whatever is asked for. */
export const StravaActivitiesPageSchema = z.looseObject({
	models: z.array(StravaActivitySchema),
	page: z.number(),
	perPage: z.number(),
	total: z.number()
});

/** `GET /activities/<id>/streams?stream_types[]=…`: parallel arrays, one entry per point. */
export const StravaStreamsSchema = z.looseObject({
	/** `[lat, lng]`. Absent when the activity has no GPS. */
	latlng: z.array(z.tuple([z.number(), z.number()])).optional(),
	altitude: z.array(z.number().nullable()).optional(),
	/** Seconds since the activity's start. */
	time: z.array(z.number()).optional()
});
export type StravaStreams = z.infer<typeof StravaStreamsSchema>;

/**
 * A route as `POST /api/next/data/routes/my-routes` lists it. Ids are 19-digit strings: past
 * 2^53, so they must never go through a number.
 */
export const StravaRouteSchema = z.looseObject({
	id: z.string(),
	title: z.string().nullable(),
	length: nullableNumber,
	elevationGain: nullableNumber,
	creationTime: z.string().nullable().optional(),
	routeType: z.string().nullable().optional(),
	isPrivate: z.boolean().nullable().optional(),
	athlete: z.looseObject({ id: z.string() })
});
export type StravaRoute = z.infer<typeof StravaRouteSchema>;

export const StravaRoutesPageSchema = z.looseObject({
	me: z.looseObject({
		id: z.string(),
		searchRoutes: z.looseObject({
			nodes: z.array(StravaRouteSchema),
			pageInfo: z.looseObject({
				endCursor: z.string().nullable().optional(),
				hasNextPage: z.boolean()
			})
		})
	})
});

/** `GET /athletes/<id>/photos`: `{ items, next_cursor, has_more }`, paged with `cursor=`. */
export const StravaPhotoSchema = z.looseObject({
	photo_id: z.string(),
	activity_id_str: z.string().nullable().optional(),
	/** Already HTML-escaped by the platform. */
	caption_escaped: z.string().nullable().optional(),
	/** The largest rendition the site offers, on the photo host. */
	large: z.string(),
	video: z.unknown().optional(),
	lat: nullableNumber,
	lng: nullableNumber,
	owner_id: z.number()
});
export type StravaPhoto = z.infer<typeof StravaPhotoSchema>;

export const StravaPhotosPageSchema = z.looseObject({
	items: z.array(StravaPhotoSchema),
	next_cursor: z.string().nullable().optional(),
	has_more: z.boolean()
});
