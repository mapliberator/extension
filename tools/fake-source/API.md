# fake-source API contract

`tools/fake-source` is a synthetic server that impersonates a **Gaia-GPS-shaped** and an
**AllTrails-shaped** platform for development, e2e tests and large-archive tests. The shapes are
plausible inventions until the Phase 0 probes replace them with recorded findings. The adapters
in `src/adapters/` are written against this document; neither side imports the other.

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
- Unauthenticated API request: **Gaia** → `401` JSON `{"detail":"Authentication credentials were
not provided."}`. **AllTrails** → `302` to `/login` (so `fetch` ends on a 200 HTML page with
  `response.redirected === true`).

## Sentinels

Exported as `SENTINELS`. None of these may ever appear in an archive (decompressed or raw):

```ts
export const SENTINELS = {
	sessionCookie: {
		gaiagps: 'SENTINEL-SESSION-gaia-7f3a9c1e5b',
		alltrails: 'SENTINEL-SESSION-at-2d8e4f6a1c'
	},
	csrfToken: 'SENTINEL-CSRF-91b7c3d5e2f4',
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

Plant them generously: e-mail + CSRF token in `/me`; `user_email` on every Gaia object; other
user's name/e-mail on shared folders, on other users' objects and in `user` blocks; trail
description + geometry on every saved trail. A trail's **representative coordinate** (`trailhead`
/ `location`) is a _different_ point that is not in `trailCoordinates` and is allowed in archives.

## Gaia-shaped API (`gaia.localhost`)

All under `/api/v3`. Listings are page-numbered:
`GET /api/v3/<type>/?page=1&page_size=50` →

```jsonc
{ "count": 7, "next": "http://gaia.localhost:4610/api/v3/track/?page=2&page_size=3", "previous": null, "results": [ … ] }
```

The server clamps `page_size` to the dataset's `maxPageSize` (small dataset: **3**) so pagination
is always exercised. `count` includes objects of other users that appear in the listing.

Timestamps are ISO 8601 **with a non-UTC offset** (e.g. `2024-06-02T07:11:09-07:00`); distances in
meters; IDs are opaque strings.

`GET /api/v3/me/` →
`{ "id": "gu-1001", "display_name": "Test H.", "email": SENTINELS.email, "csrf_token": SENTINELS.csrfToken, "units": "imperial" }`

Common object fields (track, route, waypoint, area, photo, folder):
`id, title, notes, time_created, updated_date, public (bool), user_id, user_email, tags: string[]`.
Objects with `user_id !== me.id` belong to `{ user_id: 'gu-2002', user_name: SENTINELS.otherUserName }`
and carry `notes: SENTINELS.otherUserDescription`; own objects have no `user_name` key.

- **track** summary: common + `activities: string[]`, `distance`, `total_ascent`, `total_time` (s),
  `color`, `start_location: { latitude, longitude }`.
  - `GET /api/v3/track/<id>/` → summary + `geometry: { type: 'MultiLineString', coordinates: [[[lon, lat, ele, epochSeconds], …], …] }`
  - `GET /api/v3/track/<id>.gpx` → `application/gpx+xml`, GPX 1.1 `<trk>` with a `gaia:` extension
    namespace and a `<metadata>` block. UTF-8, no BOM, non-ASCII characters in at least one name.
- **route**: common + `activities`, `distance`, `total_ascent`, `start_location`.
  detail geometry `coordinates: [[[lon, lat, ele], …]]`; native GPX uses **`<rte>`/`<rtept>`**.
- **waypoint**: common + `icon`, `geometry: { type: 'Point', coordinates: [lon, lat, ele] }` (in the listing).
- **area**: common + `area` (m²), `geometry: { type: 'Polygon', coordinates }` (in the listing).
- **photo**: common + `caption`, `taken_at` (nullable), `latitude`, `longitude` (nullable),
  `fullsize_url` (absolute, on the CDN host: `/photos/<id>/full`), `attached_to: { type: 'track'|'route'|'waypoint', id } | null`.
  CDN responses: `image/jpeg` for most, at least one `image/png` and one `image/heic`; URL paths
  carry **no** file extension. Bytes are deterministic pseudo-random with a valid magic prefix.
  `Content-Length` is always sent.
- **folder**: `id, name, notes, parent (id|null), time_created, updated_date, user_id, user_email,
shared_by: { name, email } | null, tracks: id[], routes: id[], waypoints: id[], areas: id[],
saved_hikes: SavedHike[]`
  - `SavedHike = { id, name, url, trailhead: { latitude, longitude }, description, geometry: { type: 'LineString', coordinates }, user_notes: string|null, completed_on: 'YYYY-MM-DD'|null, user_rating: number|null }`
    — `description` and `geometry` are platform-owned sentinels.

Small dataset (Gaia): 7 tracks listed (6 own + 1 other user's), 5 routes listed (4 own + 1
other's), 5 own waypoints, 2 own areas, 5 photos listed (4 own + 1 other's; one own photo is
unattached, one PNG, one HEIC), 4 folders listed: 3 own (one nested under another; one contains the
other user's track and 2 saved hikes, one with annotations) + 1 shared-with-me folder
(`user_id: gu-2002`, `shared_by` set). Membership is many-to-many: at least one track is in two
folders. **Expected collections: 4** — the adapter emits the 3 own folders plus one synthesized
"Shared with me" collection holding the shared folder as a reference.
Expected `references` = the 2 saved hikes (the other user's track and the shared folder are also
references in the archive but are not listed in `expected.references`).

Names must exercise the filename sanitizer: one with `/` and `..`, one with emoji only, one with
accents, one > 100 characters, two objects with identical names.

## AllTrails-shaped API (`alltrails.localhost`)

All under `/api/alltrails/v3`. Listings are cursor-based:
`GET …?cursor=<opaque>&limit=50` → `{ "items": [ … ], "meta": { "nextCursor": "…" | null } }`
(`limit` clamped to `maxPageSize`). Timestamps are **epoch seconds** (numbers); IDs are **numbers**;
distances in meters.

- `GET /me` → `{ "user": { "id": 7001, "firstName": "Test", "lastName": "Hiker", "email": SENTINELS.email, "slug": "test-hiker", "metric": false }, "csrfToken": SENTINELS.csrfToken }`
  (display name the adapter derives: `"Test H."`)
- `GET /users/<uid>/stats` → `{ "activities": n, "maps": n, "photos": n, "completed": n }` (no list count).
- `GET /users/<uid>/activities` — recordings (→ tracks):
  `{ id, name, notes, createdAt, updatedAt, activityType: { uid: 'hiking' }, private, user: { id, name }, summaryStats: { distanceTotal, elevationGain, timeTotal }, location: { latitude, longitude } }`
  - `GET /activities/<id>` → + `segments: [{ polyline: { pointsData: '<encoded polyline, precision 5>', elevationData: number[] | null, timeData: number[] | null } }]`
    (`elevationData` meters, `timeData` epoch seconds, same length as the decoded points)
  - `GET /activities/<id>/export?format=gpx` → GPX 1.1 `<trk>`.
- `GET /users/<uid>/maps` — custom maps (→ routes): same fields as activities minus `timeTotal`,
  plus `description` and `waypoints: [{ id, name, description, location: { latitude, longitude }, createdAt }]`
  - `GET /maps/<id>` → + `segments`; `GET /maps/<id>/export?format=gpx`.
  - Waypoints exist only embedded in maps. No areas on this platform.
- `GET /users/<uid>/lists` — `{ id, name, description, private, createdAt, updatedAt, user: { id, name }, items: ListItem[] }`
  - `ListItem = { type: 'trail', trail: Trail } | { type: 'map', id } | { type: 'activity', id }`
  - `Trail = { id, name, slug, description, location: { latitude, longitude }, polyline: { pointsData }, user: null }`
    — `description` + `polyline` are platform-owned sentinels; public URL is
    `<origin>/trail/<slug>`.
- `GET /users/<uid>/completed` — `{ trail: Trail, completedAt: 'YYYY-MM-DD', rating: 1..5 | null, review: string | null, privateNotes: string | null }`
- `GET /users/<uid>/photos` — `{ id, title, caption, createdAt, takenAt (nullable), user: { id, name }, location: { latitude, longitude } | null, urls: { original?: string, large: string }, attachedTo: { type: 'activity'|'map'|'trail', id } | null }`
  CDN path `/p/<id>/<rendition>`.

Small dataset (AllTrails): 5 activities listed (4 own + 1 by the other user), 3 own maps with 4
embedded waypoints total, 0 areas, 2 lists (one with 2 trails + 1 map + 1 activity, one with 1
trail that also appears in the first list), 2 completed trails (with rating/review/notes), 4 photos
(3 own — one without `urls.original`, one attached to a trail — + 1 other user's).
**Expected collections: 3** — the 2 lists plus one synthesized "Completed trails" collection.
Expected `references` = the distinct saved/completed trails.

## Large dataset

`dataset: 'large'` or `{ kind: 'large', photos: 1100, photoBytes: 5_000_000 }`: Gaia platform only,
2 tracks, 0 of everything else, `photos` photos of `photoBytes` each (≥ 5 GB total by default),
generated on the fly without allocating per-photo buffers (reuse one pseudo-random block; vary a
small per-photo header so files differ). `maxPageSize` 100.

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
		| { kind: 'schema-drift' } // listing answers with renamed keys (`results`→`data`, `items`→`entries`)
		| { kind: 'delay'; ms: number }; // respond normally after a delay
}
```

Faults are evaluated in order; the first whose `match` (and platform) hits and whose skip/count
window is open wins. `status` with 429 sends `Retry-After` when `retryAfter` (seconds) is set.
