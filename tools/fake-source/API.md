# fake-source API contract

`tools/fake-source` is a synthetic server that impersonates a **Gaia-GPS-shaped** and an
**AllTrails-shaped** platform for development, e2e tests and large-archive tests. Both platforms' shapes follow the
recorded Phase 0 findings (`docs/phase0-findings.md`); what could not be observed is left out
rather than invented. The adapters in `src/adapters/` are written
against this document; neither side imports the other.

One Node HTTP server, one port (default **4610**), routed by `Host` header:

| Host                           | Role                        |
| ------------------------------ | --------------------------- |
| `gaia.localhost:4610`          | Gaia-shaped site + API      |
| `cdn.gaia.localhost:4610`      | Gaia-shaped photo CDN       |
| `alltrails.localhost:4610`     | AllTrails-shaped site + API |
| `cdn.alltrails.localhost:4610` | AllTrails-shaped photo CDN  |

Listen on `127.0.0.1` (and `::1` when available). No CORS headers anywhere — the extension must
work through host permissions exactly as it would against the real sites.

## Programmatic API (used by e2e tests, in-process)

```ts
import { startFakeSource, SENTINELS } from '../tools/fake-source/index.ts';

const fake = await startFakeSource({
	port: 4610,
	dataset: 'small' /* | 'large' | DatasetOptions */
});
fake.origin('gaiagps'); // 'http://gaia.localhost:4610'
fake.sessionCookie('gaiagps'); // { name, value, domain, path, httpOnly } ready for Playwright addCookies (url-less form: domain+path)
fake.setFaults(faults); // replace active faults (also resets their counters)
fake.login('gaiagps'); // re-activate a session killed by an expire-session fault
fake.logout('gaiagps'); // server-side session invalid until login()
fake.resetLog();
fake.log(); // RequestLogEntry[]
fake.stats('gaiagps'); // { apiRequests, assetRequests, peakApiConcurrency, peakAssetConcurrency, minApiGapMs }
fake.expected('gaiagps'); // ExpectedArchive — see below
fake.nativeGpx('gaiagps', 'track', id); // Buffer: exact bytes the GPX endpoint serves for that object
await fake.close();
```

`RequestLogEntry = { platform, lane: 'api' | 'asset' | 'page', method, path, status, start, end }`
(`start`/`end` from `performance.now()`; `status` is `0` for a dropped connection).

- **lane `api`** = every request under `/api/` on a site host (JSON and GPX).
- **lane `asset`** = every request on a CDN host. **lane `page`** = everything else.
- `peakApiConcurrency` = max simultaneously in-flight `api` requests; `minApiGapMs` = smallest
  difference between consecutive `api` request **start** times (Infinity with < 2 requests).

```ts
interface ExpectedArchive {
	account: { id: string; displayName: string };
	/** Counts of objects AUTHORED by the account (what a clean export must contain). */
	counts: {
		tracks: number;
		routes: number;
		waypoints: number;
		areas: number;
		collections: number;
		photos: number;
	};
	/** Source IDs of authored objects, in listing order. */
	ids: {
		tracks: string[];
		routes: string[];
		waypoints: string[];
		areas: string[];
		photos: string[];
	};
	/** Saved platform trails that must show up as `reference` members. */
	references: { name: string; url: string; sourceId: string; coordinate: [number, number] }[];
}
```

`counts.collections` is the number of collections the adapter is expected to emit (documented per
platform below, including synthesized ones).

A CLI (`cli.ts`, `npm run fake-source -- --port 4610 --dataset small`) starts the same server and
prints the origins and a ready-to-paste session cookie. HTTP control endpoints for manual use:
`POST /__control/login?platform=gaiagps`, `POST /__control/logout?platform=…`,
`POST /__control/faults` (JSON body = Fault[]), `GET /__control/stats?platform=…`. `/__control/*`
is served on any host and is never logged.

## Sessions

Cookie `fs_session` (HttpOnly, Path=/, host-only) per site host. A request is authenticated when
the cookie value equals that platform's session value **and** the server-side session is active.

- `GET /` — tiny HTML home page. When signed in it contains the account e-mail and
  `<meta name="csrf-token" content="…">` (both sentinels). When signed out it links to `/login`.
- `GET /robots.txt` — `text/plain`, always 200. The extension parks its source tab here.
- `GET /login` — HTML form; `POST /login` sets the cookie, activates the session, 303 → `/`.
- Unauthenticated API request: **Gaia** → `403`, `text/html`, empty body — except
  `GET /api/v3/user/`, which answers `200 {"id":null,"display_name":"","is_authenticated":false}`,
  and the photo redirects below, which need no session at all. **AllTrails** → `302` to `/login`
  (so `fetch` ends on a 200 HTML page with `response.redirected === true`).

## Sentinels

Exported as `SENTINELS`. None of these may ever appear in an archive (decompressed or raw):

```ts
export const SENTINELS = {
	sessionCookie: {
		gaiagps: 'SENTINEL-SESSION-gaia-7f3a9c1e5b',
		alltrails: 'SENTINEL-SESSION-at-2d8e4f6a1c'
	},
	csrfToken: 'SENTINEL-CSRF-91b7c3d5e2f4',
	/** Signature on the short-lived photo URLs the Gaia-shaped site redirects to. */
	photoSignature: 'SENTINEL-PHOTO-SIGNATURE-5c1d7e9a',
	email: 'sentinel.hiker@example.test',
	otherUserName: 'Sentinel Otheruser',
	otherUserEmail: 'sentinel.other@example.test',
	trailDescription: 'SENTINEL-TRAIL-DESCRIPTION editorial text owned by the platform',
	/** Decimal strings that occur only inside platform-owned trail geometry. */
	trailCoordinates: ['37.746193', '-119.533287', '37.748811', '-119.530462'],
	/** The same geometry as an encoded polyline (AllTrails shape). */
	trailPolyline: '<computed from the coordinates above, precision 5>',
	/** Description text on another user's object that shows up in the account's listings. */
	otherUserDescription: 'SENTINEL-OTHER-USER-DESCRIPTION'
};
```

Note `trailCoordinates` for the polyline case: with precision 5 the decoded values are
`37.74619` etc. — also export `trailCoordinatesP5` with those strings.

Plant them generously. Gaia: e-mail and a secret (`didomi_auth.digest` = the CSRF sentinel) on
`/api/v3/user/`; `user_email`, `username`, `user_displayname` and `created_by` on every object
**detail**; the other user's name/e-mail on their objects' details and their description in the
`notes` of their listed objects and shared folders; the signature on photo redirects. AllTrails:
e-mail + CSRF token in `/me`; other users in `user` blocks; trail description + geometry on every
saved trail. A trail's **representative coordinate** (`trailhead` / `location`) is a _different_
point that is not in `trailCoordinates` and is allowed in archives.

## Gaia-shaped API (`gaia.localhost`)

Follows `docs/phase0-findings.md`. IDs here stay short and readable (`gt-3001`) where the real
ones are 32 hex characters; the account id is a **number** (`1001`; the other user is `2002`).

`GET /api/v3/user/` →
`{ id: 1001, display_name: "Test H.", username, email, first_name, last_name, is_authenticated: true, distance_units, didomi_auth: { id, algorithm, digest } }`

**Listings** — `GET /api/objects/<type>/` for `track | route | waypoint | area | photo | folder`
→ the **whole collection as one bare JSON array**. No pagination; query parameters are ignored.
Listings include **soft-deleted** objects (`deleted: true`) and **never say who owns an object**.

Common listing fields: `id, updated_date, time_created` (`…Z`), `last_updated_on_server`
(microseconds, no zone), `deleted, title, notes, public, folder, folder_name, path, sync_to_mobile`.

- **track / route**: common + `distance, total_ascent, total_time` (0 for routes), `activities: string[]`, `privacy_level, source` (nullable).
- **waypoint**: common + `icon, marker_type, marker_color, marker_decoration, latitude: [n], longitude: [n]` (one-element arrays), `cover_photo_id`. No elevation.
- **area**: common + the track fields, all zero (`distance, total_ascent, total_time, activities, privacy_level, source`). No size.
- **photo**: common + `thumbnail, scaled` (URLs on the site host), `waypoint_id, waypoint_name`. Every photo hangs off a waypoint; there is no coordinate or capture time in the listing.
- **folder**: `id, updated_date, time_created, last_updated_on_server, deleted, title, public, revision, notes, tracks: id[], routes: id[], areas: id[], waypoints: id[], maps, mapSources, children: id[], date_group, cover_photo_id, path, imported, folder, is_shared, access ('owner' | 'read'), sync_to_mobile, preferred_link, parent (id|null), folder_name, writable`.

**Details** — `GET /api/objects/<type>/<id>/` → GeoJSON:

- track / route: `{ type: 'FeatureCollection', id, features: [ { type: 'Feature', id, properties, style, geometry: { type: 'MultiLineString', coordinates } } ] }`. Coordinates are `[lon, lat, ele, epochSeconds]`; routes carry `0` in the last slot. `properties` adds the owner block — `user_displayname, username, user_email, user_id, created_by: { id, displayName, link, image }, writable` — plus `latitude, longitude, color, hexcolor, preferred_link, …`.
- waypoint: `Feature` with `geometry.coordinates: [lon, lat]` and `properties.elevation` (nullable).
- area: a `FeatureCollection` like a track's, whose one Feature has `properties.track_type: 'polygon'` and a `Polygon` of `[lon, lat, ele]` vertices.
- photo: `Feature` with a `Point` and `properties.{thumbnail_url, web_url, scaled_url, fullsize_url}`.
- folder: `FeatureCollection` whose `properties.name` is the folder name (`title` in the listing), with member stubs; `features` is empty here (the real one embeds every member).

**Native GPX** — `GET /api/objects/<track|route>/<id>.gpx` (trailing `/` optional) →
`application/gpx+xml`, GPX 1.1, `creator="GaiaGPS"`, `<trk>` for tracks and `<rte>/<rtept>` for
routes, a `gaia:` extension namespace. UTF-8, no BOM, non-ASCII characters in at least one name.

**Photos** — `GET /api/objects/photo/<id>/image/<size>/` on the site host answers **without a
session** with a `302` to `http://cdn.gaia.localhost:<port>/photos/<id>/full?Expires=…&Signature=<sentinel>`.
The photo host serves `image/jpeg` for most, at least one `image/png` and one `image/heic`; bytes
are deterministic pseudo-random with a valid magic prefix; `Content-Length` is always sent. These
redirect hops are logged in lane **`asset`**, not `api`.

Small dataset (Gaia): 8 tracks listed (6 own + 1 other user's + 1 deleted), 5 routes listed (4 own

- 1 other's), 6 waypoints (5 own + 1 deleted), 2 own areas, 5 photos (4 own + 1 deleted; one PNG,
  one HEIC, one whose waypoint was deleted), 5 folders: 3 own (one nested under another; one holding
  the other user's track), 1 deleted, 1 shared-with-me (`access: 'read'`, `is_shared: true`).
  Membership is many-to-many: at least one track is in two folders. **Expected collections: 4** —
  the 3 own folders plus one synthesized "Shared with me" collection holding the shared folder as a
  reference. Expected `references` = the other user's track filed in one of my folders (the shared
  folder is also a reference in the archive but is not listed in `expected.references`).

Names must exercise the filename sanitizer: one with `/` and `..`, one with emoji only, one with
accents, one > 100 characters, two objects with identical names.

## AllTrails-shaped API (`alltrails.localhost`)

Follows `docs/phase0-findings.md`. All under `/api/alltrails`. IDs are **numbers**, timestamps are
`YYYY-MM-DDTHH:MM:SSZ` strings, distances in meters.

**Every API call needs the header `X-AT-KEY: fakeatkey0123456789abcdef0123456`** (also
`SENTINELS.appKey`: it must never reach an archive). Without it → `400`
`{ errors: [{ code: 'missing_key', message, target: null, debug: null }], meta: { status: 'error' } }`;
a wrong one → `invalid_key`; an unknown path → `400 method_not_found`. The adapter restates the
key in `src/adapters/alltrails/key.ts` — neither side imports the other.

An API call whose `Referer` ends in `/robots.txt` — the page the extension parks its tab on — gets
`403 {"url": "…"}`, the real site's bot-protection challenge. The executor therefore sends no
referrer at all.

- `GET /me` → `{ users: [User], meta }`. User: `id, username, firstName, lastName, slug, email`
  (sentinel), `referralCode` (the CSRF sentinel), counters `tracks, maps, photos` — and
  `lists: 0, favorites: 0`, which are wrong on purpose, as on the real API.
- `GET /users/<uid>/maps?presentation_type=track|map&limit=&after=` → recordings or custom routes
  (both when the type is omitted). Another user's id → `403`.
- Listings are `{ <resource>: [...], meta, pageInfo: { totalItemCount, itemCount, hasNextPage, nextCursor? } }`.
  The next page is `after=<nextCursor>`; `cursor` and other names are **ignored** (first page
  again); a garbage `after` → `400`. `limit` is clamped to `maxPageSize`.
- Map (listing): `id, name, description, presentationType, slug, created_at, location: { latitude: "…", longitude: "…" }` (strings), `trailId, activity: { uid, name }, user: { id, username, firstName, lastName, slug }, private, contentPrivacy, summaryStats: { duration, distanceTotal, elevationGain }, photoCount, metadata: { created, updated, status, cursor }`. No geometry.
- `GET /maps/<id>?detail=deep` → `{ maps: [detail] }`: the listing fields plus `waypoints`,
  `mapPhotos`, `map_source` and either
  `tracks: [{ lineTimedSegments: [{ sequence_num, dateTimeStart, dateTimeStop, polyline: { pointsData, indexedTimeData, elevationData: null, indexedElevationData } }] }]` (recordings) or
  `routes: [{ lineSegments: [{ sequence_num, polyline: { pointsData, indexedElevationData } }] }]` (custom routes).
  Without `detail=deep` the answer is the listing shape.
  - `pointsData`: encoded polyline, precision 5, `[lat, lon]`.
  - `indexed…Data`: delta-coded pairs `(pointIndex × 100, value)`; elevation value = metres × 10⁵
    (`null` when the line has no elevations); time value = hundredths of a second from an
    arbitrary origin — read it relative to the segment's `dateTimeStart`.
  - Waypoint: `id, name, name_original, description (null|string), order, location: { latitude, longitude }` (numbers), `at_map_id, waypointCategory: { id, name, uid, icon }, contentPrivacy, isGlobal, user: { id, first_name }` (snake_case here).
  - `mapPhotos: [{ id, mapId, location, photo }]` is the **only** place a photo is tied to its map.
- `GET /users/<uid>/photos?limit=&after=` → `photos: [{ id, title, description, likeCount, photoHash, trailId, trailIds, location: { latitude, longitude } (numbers or null), user, metadata: { created, updated, status } }]`. No URL.
- Photo file: `GET /api/alltrails/v3/photos/<id>/image?key=<app key>&size=<anything>` (also
  without `v3/`) — **no session needed**, `400` without the key — → `302` to
  `http://cdn.alltrails.localhost:<port>/p/<id>/full`. Logged in lane **`asset`**.
- `GET /users/<uid>/lists` → `lists: [{ id, order, type ('user-built-in' | 'user-custom'), slug, private, contentPrivacy, ownerId, isCollaborative, metadata: { itemsCount: 0 … }` (stale on purpose) `, name, description, user }]`.
- `GET /lists/<id>/items` → `{ listItems: [{ id, listId, type: 'trail', order, notes, trailId, metadata }], meta }` — ids only.
- `GET /trails/<id>` → `{ trails: [{ id, name, slug ('us/california/<name>'), overview, location: { city, latitude, longitude }, defaultMap: { polyline: { pointsData } } }] }`. `overview` and the polyline are platform-owned sentinels; the page is `/trail/<slug>`.

There is **no GPX export**, no completed-trails or reviews endpoint (unobserved), and
`fake.nativeGpx('alltrails', …)` throws.

Small dataset (AllTrails): 5 recordings listed (4 own, one with 2 segments, one without
elevations, one with a waypoint; 1 other user's), 3 own custom routes (two with 2 waypoints each),
4 photos (3 own: one on a recording, one on a route with no location, one posted on a platform
trail and so unattached; 1 other user's), 3 lists: Favorites (2 trails, one with a note), an
empty built-in list, and a custom list (2 trails). **Expected collections: 2** — lists without
items are not exported. Expected `references` = the 3 distinct saved trails.

## Large dataset

`dataset: 'large'` or `{ kind: 'large', photos: 1100, photoBytes: 5_000_000 }`: Gaia platform only,
2 tracks, 2 waypoints (every photo hangs off one of them), 0 of everything else, `photos` photos
of `photoBytes` each (≥ 5 GB total by default), generated on the fly without allocating per-photo
buffers (reuse one pseudo-random block; vary a small per-photo header so files differ). The photo
listing is one response, like every Gaia listing.

## Faults

```ts
interface Fault {
	platform?: 'gaiagps' | 'alltrails';
	/** RegExp source tested against `path + search`. */
	match: string;
	/** Let this many matching requests through first. Default 0. */
	skip?: number;
	/** Then apply to this many matching requests; omit = forever. */
	count?: number;
	action:
		| { kind: 'status'; status: number; retryAfter?: number; body?: string } // 429, 403, 500, 404 …
		| { kind: 'challenge' } // 200 text/html "Checking your browser…" page
		| { kind: 'drop'; when?: 'before-response' | 'mid-response' } // destroy the socket; Chromium silently re-sends a GET once after a before-response reset on a reused socket, so use 'mid-response' when measuring pacing
		| { kind: 'expire-session' } // invalidate the platform session, then answer as unauthenticated
		| { kind: 'schema-drift' } // listing answers in a changed shape: a bare Gaia array gains a `{count, results}` envelope, `items`→`entries`
		| { kind: 'delay'; ms: number }; // respond normally after a delay
}
```

Faults are evaluated in order; the first whose `match` (and platform) hits and whose skip/count
window is open wins. `status` with 429 sends `Retry-After` when `retryAfter` (seconds) is set.
