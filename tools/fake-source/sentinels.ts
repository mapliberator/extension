import { encodePolyline } from './polyline.ts';

const trailCoordinates = ['37.746193', '-119.533287', '37.748811', '-119.530462'] as const;

/** The two sentinel points as numbers, [lat, lon]. */
export const SENTINEL_TRAIL_POINTS: readonly (readonly [number, number])[] = [
	[Number(trailCoordinates[0]), Number(trailCoordinates[1])],
	[Number(trailCoordinates[2]), Number(trailCoordinates[3])]
];

/** `trailCoordinates` as they come out of a precision-5 polyline. */
export const trailCoordinatesP5: string[] = trailCoordinates.map((s) =>
	(Math.round(Number(s) * 1e5) / 1e5).toFixed(5)
);

/** None of these may ever appear in an archive (decompressed or raw). */
export const SENTINELS = {
	sessionCookie: {
		gaiagps: 'SENTINEL-SESSION-gaia-7f3a9c1e5b',
		alltrails: 'SENTINEL-SESSION-at-2d8e4f6a1c'
	},
	csrfToken: 'SENTINEL-CSRF-91b7c3d5e2f4',
	/** The AllTrails-shaped site's app key: sent on every call and in photo URLs, never archived. */
	appKey: 'fakeatkey0123456789abcdef0123456',
	/** Signature on the short-lived photo URLs the Gaia-shaped site redirects to. */
	photoSignature: 'SENTINEL-PHOTO-SIGNATURE-5c1d7e9a',
	email: 'sentinel.hiker@example.test',
	otherUserName: 'Sentinel Otheruser',
	otherUserEmail: 'sentinel.other@example.test',
	trailDescription: 'SENTINEL-TRAIL-DESCRIPTION editorial text owned by the platform',
	/** Decimal strings that occur only inside platform-owned trail geometry. */
	trailCoordinates: [...trailCoordinates] as string[],
	/** The same strings at polyline precision 5 (what a decoder yields for the AllTrails shape). */
	trailCoordinatesP5,
	/**
	 * The two sentinel points as an encoded polyline (precision 5). Every AllTrails-shaped trail's
	 * `polyline.pointsData` STARTS with this string.
	 */
	trailPolyline: encodePolyline(SENTINEL_TRAIL_POINTS, 5),
	/** Description text on another user's object that shows up in the account's listings. */
	otherUserDescription: 'SENTINEL-OTHER-USER-DESCRIPTION'
};
