/**
 * Garmin Connect response schemas, written against the recorded shapes in
 * docs/phase0-findings.md. Everything platform-specific stays inside this directory (PRD §6.5).
 * Objects are loose: unknown extra fields are not drift.
 */
import { z } from 'zod';

const nullableNumber = z.number().nullable().optional();
const nullableString = z.string().nullable().optional();
const typeKey = z.looseObject({ typeKey: nullableString }).nullable().optional();

/** `GET /gc-api/userprofile-service/socialProfile`. `displayName` is a UUID, not a name. */
export const GarminSocialProfileSchema = z.looseObject({
	/** Equals an activity's `ownerId` and a course's `userProfileId`. */
	profileId: z.number(),
	fullName: nullableString
});
export type GarminProfile = z.infer<typeof GarminSocialProfileSchema>;

/** `GET /gc-api/activitylist-service/activities/count` */
export const GarminActivityCountSchema = z.looseObject({ totalCount: z.number() });

/** One activity, as `GET …/activities/search/activities` lists it. */
export const GarminActivitySchema = z.looseObject({
	activityId: z.number(),
	activityName: nullableString,
	/** Not observed: present, if ever, only on activities that have one. */
	description: nullableString,
	activityType: typeKey,
	/** `public`, `private`, or `subscribers` (followers). */
	privacy: typeKey,
	/** Start, epoch milliseconds. (`startTimeGMT` has no zone and reads as local time.) */
	beginTimestamp: nullableNumber,
	distance: nullableNumber,
	duration: nullableNumber,
	elapsedDuration: nullableNumber,
	elevationGain: nullableNumber,
	/** False on indoor activities: their GPX export is a file without points. */
	hasPolyline: z.boolean(),
	ownerId: z.number()
});
export type GarminActivity = z.infer<typeof GarminActivitySchema>;

/** A bare array, newest first, paged with `start=` (0-based) and `limit=`. */
export const GarminActivitiesPageSchema = z.array(GarminActivitySchema);

/**
 * `GET …/activity/<id>/details`: one row per point, its columns named by `metricDescriptors`.
 * A descriptor's `metricsIndex` is its column, which is not its position in the list.
 */
export const GarminActivityDetailsSchema = z.looseObject({
	metricDescriptors: z.array(z.looseObject({ metricsIndex: z.number(), key: z.string() })),
	activityDetailMetrics: z.array(z.looseObject({ metrics: z.array(z.number().nullable()) }))
});
export type GarminActivityDetails = z.infer<typeof GarminActivityDetailsSchema>;

/** A course, as the owner and favourites listings have it. */
export const GarminCourseSchema = z.looseObject({
	courseId: z.number(),
	userProfileId: z.number(),
	courseName: nullableString,
	courseDescription: nullableString,
	activityType: typeKey,
	/** `public` or `private`. */
	privacyRule: typeKey,
	/** Epoch milliseconds. */
	createdDate: nullableNumber,
	updatedDate: nullableNumber,
	distanceInMeters: nullableNumber,
	elevationGainInMeters: nullableNumber,
	startLatitude: nullableNumber,
	startLongitude: nullableNumber
});
export type GarminCourse = z.infer<typeof GarminCourseSchema>;

/** `GET /gc-api/web-gateway/course/owner/`: every course, no paging. */
export const GarminCoursesSchema = z.looseObject({ coursesForUser: z.array(GarminCourseSchema) });

/** `GET /gc-api/course-service/course/favorites`: a bare array, other users' courses included. */
export const GarminFavoritesSchema = z.array(GarminCourseSchema);

/** `GET /gc-api/course-service/course/<id>`: the fallback geometry. */
export const GarminCourseDetailSchema = z.looseObject({
	geoPoints: z.array(
		z.looseObject({
			latitude: z.number(),
			longitude: z.number(),
			elevation: nullableNumber
		})
	)
});
export type GarminCourseDetail = z.infer<typeof GarminCourseDetailSchema>;
