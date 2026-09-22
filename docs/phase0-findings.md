# Phase 0 probe findings

Recorded 2026-09-21 from a signed-in Chrome session, same-origin `fetch` from a page on each
site (Gaia GPS, AllTrails, Strava). Only response **shapes** were recorded (keys, types, string
lengths, array lengths) — no values, IDs, tokens or signed URLs. Notation: `s32` = string of length 32, `n` = number,
`b` = boolean, `dt<…>` = datetime string in that layout, `[185x {…}]` = array of 185 such items.

## Gaia GPS (`https://www.gaiagps.com`)

### What differs from the invented contract (`tools/fake-source/API.md`)

| Assumed                                                          | Real                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v3/<type>/?page=&page_size=` paged envelope                | `/api/objects/<type>/` returns the **whole list as a bare JSON array**, no pagination                                                                                |
| `/api/v3/me/`                                                    | 404. Account is `GET /api/v3/user/`                                                                                                                                  |
| detail = flat object + `geometry`                                | detail = GeoJSON (`FeatureCollection` for track/route/folder, `Feature` for waypoint/photo)                                                                          |
| `/api/v3/track/<id>.gpx`                                         | `/api/objects/<type>/<id>.gpx` (with or without trailing `/`), for track, route, waypoint **and folder**                                                             |
| unauthenticated → 401 JSON                                       | **403**, `text/html`, empty body                                                                                                                                     |
| photo `fullsize_url` on a CDN host                               | `/api/objects/photo/<id>/image/full/` on www, which redirects to a signed URL on `photos.gaiagps.xyz`                                                                |
| asset hosts `static.gaiagps.com`, `gaia-photos.s3.amazonaws.com` | `photos.gaiagps.xyz` (CloudFront-signed, short expiry). Avatars come from `s3.amazonaws.com` (not exported)                                                          |
| timestamps with non-UTC offset                                   | `updated_date`/`time_created` are `YYYY-MM-DDTHH:MM:SSZ`; `last_updated_on_server` has microseconds and **no zone**; folder member `time_created` has no zone either |
| opaque string ids                                                | object ids are 32-char hex strings; `user_id` is a **number**                                                                                                        |
| waypoint geometry in listing                                     | listing has `latitude`/`longitude` only; no elevation. Detail has `geometry.coordinates: [lon, lat]` (2 numbers) plus `properties.elevation` (nullable)              |
| areas at `/api/v3/area/`, with an `area` size                    | `/api/objects/area/`: listed like a track (line fields zeroed), no size anywhere; detail is a FeatureCollection with one `Polygon` Feature                           |
| saved hikes inside folders                                       | not observed; folder has `maps`, `mapSources`, `children`/`folders` instead                                                                                          |

### Listings — `GET /api/objects/<type>/` → array

Common to every listed object:
`id:s32, updated_date:dt<0000-00-00T00:00:00Z>, time_created:dt<…Z>, last_updated_on_server:dt<0000-00-00T00:00:00.000000>, deleted:b, title:s, notes:s, public:b, folder:s (may be ""), folder_name:s, path:s, sync_to_mobile:null`

Note `deleted:b` — listings can include soft-deleted objects; the adapter must skip them.

- **track** (185 in this account): common + `distance:n, total_ascent:n, total_time:n, activities:[], privacy_level:null, source:s`
- **route** (92): same fields as track
- **waypoint** (394): common + `icon:s, marker_type:s, marker_color:s7, marker_decoration:null, latitude:[n], longitude:[n], cover_photo_id:null` — `latitude`/`longitude` are **one-element arrays** in the listing (confirmed on all 394), plain numbers in the detail
- **photo** (106): common + `thumbnail:url (/api/objects/photo/<id>/image/100/), scaled:url (/api/objects/photo/<id>/image/1000/, carries a publickey query parameter), waypoint_id:s32, waypoint_name:s`
- **folder** (34): `id, updated_date, time_created, last_updated_on_server, deleted, title, public, revision:n, notes, tracks:[id], routes:[id], areas:[id], waypoints:[id], maps:[], mapSources:[], children:[], date_group:s, cover_photo_id, path:s, imported:null, folder:null, is_shared:b, access:s5, sync_to_mobile, preferred_link:s, parent:null|id, folder_name:null, writable:b`
- **area** (third probe, after adding one): `id:s36` (a dashed UUID — ids are not always 32 hex), then the same fields as a track: `distance:n (0), total_ascent:n, total_time:n, activities:[], privacy_level:s7, source:null`, and `sync_to_mobile:b`. Areas do **not** appear in the track or route listings.

### Details — `GET /api/objects/<type>/<id>/`

- **track / route**: `{ type:"FeatureCollection", id, features:[1x Feature] }`. The feature:
  `{ type, id, properties:{…}, style:{stroke:s7}, geometry:{ type:"MultiLineString", coordinates } }`.
  Track coordinates are `[lon, lat, ele, epochSeconds]` (4 numbers, 10-digit epoch). Route
  coordinates were not arity-checked.
  `properties`: `id, updated_date, time_created, last_updated_on_server, db_insert_date, deleted, title, public, color:s7, hexcolor:s7, is_active:b, revision:n, notes, track_type:s ("" for tracks, s5 for routes), routing_mode:null|s, uploaded_gpx_to_osm, flag, source, cover_photo_id, distance, total_ascent, total_descent, stopped_time, total_time, average_speed, moving_time, moving_speed, activities:[], imported, folder, privacy_level, sync_to_mobile, preferred_link:s, user_displayname:s, username:s, user_email:s, user_id:n, created_by:{id:n, displayName, link, image:url}, favorite_count:n, is_favorite:b, comment_count:n, comments:[], user_photo_count:n, latitude:n, longitude:n, writable:b`
  — `user_email`, `username`, `user_displayname`, `created_by` must never reach the archive.
  Ownership test: `user_id` against `/api/v3/user/` `id` (both numbers), or `writable`.
- **waypoint**: `{ type:"Feature", id, geometry:{type:"Point", coordinates:[lon,lat]}, properties:{ id, updated_date, time_created, deleted, title, public, is_active, icon, revision, notes, latitude, longitude, elevation:null|n, attr, track_id:s, order, folder, marker_type, marker_color, marker_decoration, sync_to_mobile, cover_photo_id, photos:[], created_by:{…}, writable:b } }`
- **photo**: `{ type:"Feature", id, geometry:{Point [lon,lat]}, properties:{ id, updated_date, time_created, deleted, title, revision, notes, elevation:n, waypoint_id:s32, thumbnail_url, web_url, scaled_url, fullsize_url } }`
  — all four URLs are on `www.gaiagps.com`. Photos attach to **waypoints only** (`waypoint_id`).
- **folder**: `{ type:"FeatureCollection", id, properties:{ id, name, updated_date, time_created, notes, cover_photo_id, deleted, sync_to_mobile, public, bounds:[[n,n],[n,n]], tracks:[{id,title,deleted,time_created,public}], routes:[…], areas:[…], waypoints:[…], maps:[], mapSources:[], folders:[], trackstats:{} }, features:[…every member as a full Feature…] }`
  — note the name is `properties.name` here but `title` in the listing. A folder detail embeds
  every member's geometry, so it can be large.

- **area**: `{ type:"FeatureCollection", features:[1x Feature] }` with the track property set,
  `track_type:"polygon"`, `geometry:{ type:"Polygon", coordinates:[[ [lon,lat,ele], … ]] }` (one
  closed ring, 3 numbers per vertex), `preferred_link:/public/<token>`. No area or perimeter
  field. `/api/objects/area/<id>.gpx` returns a `<trk>` of the ring.

### Account — `GET /api/v3/user/`

Keys: `activities, amplitude_device_id, avatar, bio, coordinate_format, cors_proxy_url, date_joined:n, didomi_auth:{…secret…}, discover_analytics_enabled, display_name, distance_units, email, experiments, first_name, has_mobile_app, id:n, is_authenticated:b, is_eligible_for_trial, is_hijacked, is_ranger, is_staff, is_team_admin, last_name, location, privacy_policy_acknowledged_at, privacy_settings, rivt_unique_id, subscription_level, username, web_analytics_enabled`

`is_authenticated` is the signed-in check. `didomi_auth`, `email`, `amplitude_device_id`,
`rivt_unique_id` are secrets/PII — sentinel candidates for the fake server.

### Native GPX

`Content-Type: application/gpx+xml`, `Content-Disposition: attachment`, GPX 1.1, `creator="GaiaGPS"`.

- track: `gpx > trk > name, desc, extensions > line > color; trkseg > trkpt > ele, time`
- route: `gpx > rte > name, desc, extensions > line > color; rtept > ele, time`
- waypoint and folder GPX also return 200.

### Photos

- `…/image/100/`, `…/image/1000/`, `…/image/full/` on `www.gaiagps.com` each redirect to
  `https://photos.gaiagps.xyz/<id>/1000.jpg` or `/<id>.jpg` with CloudFront signing parameters.
- From a page, `fetch` of the `1000` variant succeeds (CORS allowed, `Content-Length` present);
  `fetch` of `full` **fails** (no CORS on that object path) though `<img>` loads it. The extension
  worker with a host permission for `photos.gaiagps.xyz` is not subject to CORS, but this must be
  confirmed in the real-account smoke test.
- The redirect response for `full` was logged with status 503 twice before succeeding — treat as
  retryable.

### Second probe: values that decide adapter behaviour

- **Deleted objects are common**: 39 of 185 tracks, 56 of 92 routes, 188 of 394 waypoints, 88 of
  106 photos and 3 of 34 folders had `deleted: true`. Skipping them is not optional.
- **Folders**: all 34 had `access: "owner"`, `is_shared: false`, `writable: true`; `children` holds
  folder ids (strings); 2 had a `parent`. Other `access` values are unobserved — the adapter treats
  anything but `"owner"` as somebody else's folder.
- **Listings carry no owner.** Only details do (`properties.user_id`, a number). The adapter checks
  the owner, one detail request each, only for lines that sit in a folder that is not the user's.
- **Routes** use the same 4-slot coordinates as tracks, with `0` in the time slot.
- Track `source` is a device name, `""` or `null`. `activities` was empty on every track.
- `preferred_link` is `/datasummary/<type>/<id>/` — routes link under `/datasummary/track/`.
- **`GET /api/v3/user/` answers 200 without a session** (`is_authenticated: false`), so signed-out
  detection is: bare `403` with an empty `text/html` body on the object API, or
  `is_authenticated: false` on the account endpoint.
- **Photo URLs need no session.** `…/image/1000/` fetched with credentials omitted returned the
  image via `photos.gaiagps.xyz`. The worker can therefore fetch `…/image/full/` without
  credentials, with host permissions for both hosts. Whether that also holds for photos on
  private waypoints is unverified. Photo titles look like file names (`.jpg`) or are empty.

### Session

Cookie session; same-origin `fetch` with `credentials: 'include'` is enough for every GET above.
No CSRF token or extra header was needed for reads.

## AllTrails (`https://www.alltrails.com`)

The probed account is nearly empty (1 custom route, 0 recordings, 3 empty built-in lists, no
photos, reviews or completed trails), so several shapes are still unknown — see "Still unknown".

### What differs from the invented contract

| Assumed                                                         | Real                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| base `/api/alltrails/v3`                                        | base `/api/alltrails` (`/v2/…` and `/v3/…` prefixes also answer for some paths)                                                                                                                                                                                  |
| cookie session is enough                                        | every API call also needs an **`X-AT-KEY`** header. Without it: `400 {errors:[{code:"missing_key"}]}`. The site's own client also sends `X-CSRF-TOKEN` (from a meta tag, absent on the pages probed) and `X-Language-Locale`; reads worked with `X-AT-KEY` alone |
| `{ items, meta: { nextCursor } }`                               | `{ <resource>: [...], meta: {status, items, timestamp}, pageInfo: {totalItemCount, itemCount, hasNextPage, nextCursor?} }` — the array key is the resource name (`maps`, `lists`, `listItems`, `trail_reviews`, `users`)                                         |
| `/users/<uid>/activities`, `/users/<uid>/maps` as two resources | one resource: `GET /users/<uid>/maps?limit=20&presentation_type=track` (recordings) or `=map` (custom routes)                                                                                                                                                    |
| `/users/<uid>/stats`, `/completed`, `/photos`                   | `400 method_not_found` / `404`. Counts live on the `/me` user object (`tracks, maps, photos, lists, completed, reviews, favorites, activities`)                                                                                                                  |
| unauthenticated → 302 to `/login`                               | `403` JSON whose only key is `url` — a bot-protection challenge, not a login redirect                                                                                                                                                                            |
| epoch-second timestamps                                         | ISO `YYYY-MM-DDTHH:MM:SSZ` strings                                                                                                                                                                                                                               |
| errors                                                          | `{ errors:[{code, message, target, debug}], meta:{status} }` with HTTP 400 for unknown methods                                                                                                                                                                   |

`X-AT-KEY` is a 32-character constant compiled into the site's JavaScript bundle (the chunk that
builds `shared.api.fetch.headers`, served from a CloudFront host). It is an app key, identical for
every visitor, not a user credential. **Decision needed:** hardcode it, or read it from the page
at run time. It must never be written to an archive either way. The value is deliberately not
recorded here.

### Endpoints that answered 200

- `GET /api/alltrails/me` → `{ users:[1x User], meta, pageInfo }`. User keys:
  `id:n, uuid:s36, private, username, firstName, lastName, slug, reputation, reviews, completed, favorites, following, followers, tracks, maps, photos, lists, activities, location, calorieInfo, subscription, pro:b, subscriptionTier, admin, permissions, featureEntitlements, metric:b, displaySpeed, email, email_none, profilePhoto, garminConnected, facebookConnected, googleConnected, appleConnected, marketingLangPreference, locale, …, referralCode, referral_link, created, expirationDate, aboutMe, formattedLocation, isTrailManager, privacyPolicy, communityDataSharing, emailSha256, phone, devices, audiences, reiMemberId, previewFeatureEntitlements`
  — `email`, `emailSha256`, `phone`, `referralCode`, `referral_link`, `reiMemberId` are PII/sentinel candidates.
- `GET /api/alltrails/users/<uid>` → same envelope, public view of the user.
- `GET /api/alltrails/users/<uid>/maps?limit=&presentation_type=map|track` → `maps:[Map]`.
  Map (listing): `id:n, name, description, description_lang, description_original, description_source, presentationType:"map"|"track", slug, created_at:dt, timezone, location:{postalCode, city, region, country, country_id, latitude:s, longitude:s}, bounds:{latitudeTopLeft:s, latitudeBottomRight:s, longitudeTopLeft:s, longitudeBottomRight:s}, trailId:null|n, activity:{description, name, uid, bitfieldPosition, displayPriority, type}, rating, difficulty, comment, obstacles, ratingAttributes:[], infoAttributes:[], user:User(embedded, with firstName/lastName/devices), dataUid, associatedTrailReviewId, routeType, originalAtMapId, private:b, contentPrivacy:"urn:alltrails:visibility:private"|…, hidden, popularity, summaryStats:{duration, updatedAt, elevationMax, distanceTotal, elevationGain, elevationLoss}, profilePhotoId, photoCount:n, metadata:{created:dt, updated:dt, status:"A", source:n, timezone, cursor:s88}, estimatedTimeToComplete:{value:s, unit:s}`
  — latitude/longitude/bounds are **strings**. Each item carries its own `metadata.cursor`;
  `pageInfo.nextCursor` appeared on the one-item page. The request parameter that takes the
  cursor was not observable with a single item.
- `GET /api/alltrails/maps/<id>?detail=deep` → listing fields plus
  `splits, routes:[{id, status, sequence_num, lineGeoStats:{distanceTotal, elevationGain, elevationLoss, elevationMax, elevationMin, elevationStart, elevationEnd, dateTimeStart, dateTimeStop}, lineDisplayProperty:{color}, lineSegments:[{id, sequence_num, freeDraw, polyline:{pointsData:s, indexedElevationData:s}, dateTimeStart, dateTimeStop}], estimatedTimeToComplete}], waypoints:[], mapPhotos:[], map_source:"web"`.
  Geometry is an **encoded polyline** (`pointsData`) with elevations in a second encoded string
  (`indexedElevationData`); precision and the elevation encoding still need decoding against a
  known route. Without `detail=deep` the response has no geometry.
- `GET /api/alltrails/maps/<id>/custom_route_details` → `{ id, pointsOfInterest, geoAlerts }`.
- `GET /api/alltrails/users/<uid>/lists` → `lists:[{ id:n, order, type:"user-built-in"|…, slug, dataUid, private:b, contentPrivacy, ownerId:n, isCollaborative:b, metadata:{created, itemsCount:n, status, updated}, name, description, description_lang, description_original, user:User }]`
- `GET /api/alltrails/lists/<id>` → `lists:[1]`; `GET /api/alltrails/lists/<id>/items` → `{ listItems:[], meta }` (empty here).
- `GET /api/alltrails/users/<uid>/reviews?limit=` → `trail_reviews:[]`.

### Third probe: with 1 recording, 3 custom routes and waypoints

**What an AllTrails account holds.** The `/me` counters are `tracks, maps, photos, lists,
completed, reviews, favorites, activities`. So the user's own geodata is recordings (`tracks`),
custom routes (`maps`) and the waypoints inside them — there are **no areas** — plus photos, and
non-geodata about platform trails: lists/favorites, completed trails and reviews. Those last ones
are references plus the user's own annotations, never geometry.

- **Pagination**: `?limit=<n>&after=<pageInfo.nextCursor>`. `cursor`, `next_cursor` and
  `nextCursor` are silently ignored (same first page again); `page[after]` is a 500. `limit=500`
  was accepted. Without `presentation_type` the listing mixes maps and tracks.
- **Recording detail** (`GET /maps/<id>?detail=deep`, `presentationType:"track"`): instead of
  `routes` it has `tracks:[{ id, status, sequence_num, lineTimedGeoStats:{distanceTotal, elevationGain, elevationLoss, timeMoving, timeTotal, speedAverage, speedMax, elevationMax, elevationMin, elevationStart, elevationEnd, calories, dateTimeStart:dt, dateTimeStop:dt}, lineTimedSegments:[{ id, dateTimeStart, dateTimeStop, sequence_num, freeDraw, polyline:{pointsData:s, indexedTimeData:s, elevationData:null, indexedElevationData:s, indexedHeartRateData:null} }] }]`,
  plus `splits:{metric:[…], imperial:[…], …}` and `difficultyAttributes`. A pause makes a new
  segment (one had a single point).
- **Waypoints are embedded** in the map/recording detail, not listed on their own:
  `{ id:n, name, name_lang, name_original, description (null or ""), description_lang, description_original, order:n, location:{latitude:n, longitude:n}, at_map_id:n, enable_translations:b, waypointDisplayProperty:{showTitle:b}, waypointCategory:{id, name, uid, icon}, contentPrivacy, isGlobal:b, user:{id, first_name, last_name, slug, profile_photo_url} }`.
  No elevation, no timestamp. Waypoint `user` uses snake_case where the map `user` uses camelCase.
- **Encodings** (verified by decoding in the page against the response's own bounds and stats):
  - `pointsData` is a standard encoded polyline at **precision 5**, `[lat, lon]`.
  - `indexedElevationData` and `indexedTimeData` are the same varint/zig-zag delta coding, but as
    **pairs**: `(pointIndex × 100, value)`, both delta-coded. Elevation `value` is metres × 10⁵
    (first value 152795000 ↔ `elevationStart` 1528). On the route every point had an entry.
  - Time `value` is in **hundredths of a second** on an unexplained origin (the same constant for
    both segments). Decode it relative to the segment: `time[i] = segment.dateTimeStart +
(value[i] − value[0]) / 100`, which matched `dateTimeStop` exactly (2100 ↔ 21 s).

### Fourth probe: a photo on a recording, a favourited trail

- **Photos**: `GET /users/<uid>/photos?limit=` → `{ photos:[…], pageInfo }` (this path answered
  404 while the account had no photos). Photo:
  `{ id:n, title:s, description:null|s, likeCount:n, photoHash:s32, dataUid:s36, thumbHash, trailId:null|n, trailIds:[], location:{postalCode, city, region, country, latitude:n, longitude:n}, user:User, metadata:{created:dt, updated:dt, status} }`.
  There is **no URL and no link to the recording** in it. `GET /maps/<id>/photos` → `{photos:[…]}`
  lists one map's photos.
- **Which recording a photo belongs to** is only in the map detail:
  `mapPhotos:[{ id:n, mapId:n, location:{…latitude:s, longitude:s}, photo:{…same photo object…} }]`.
  The listing's `photoCount` says which maps are worth asking.
- **Photo file**: `GET /api/alltrails/v3/photos/<id>/image?key=<X-AT-KEY value>&size=<size>` on
  the site host (`/api/alltrails/photos/…` works too). It needs **the key but no session**
  (`credentials: 'omit'` → 200; no key → 400) and redirects to `https://images.alltrails.com`,
  which sends `Content-Length` and allows CORS. `size=large` gave 375×500; `extra_large`,
  `original`, `full` and even a nonsense size all gave the same 1536×2048 file, so the largest
  rendition is what any unknown size returns. Whether 1536×2048 is the upload's true size is
  unknown — treat it as `largest-available`. A `fetch` **with** credentials fails on CORS.
  Profile pictures use `/api/alltrails/v3/profile_photos/<id>/image?key=&size=large_square`.
- **Lists**: the account has three `type:"user-built-in"` lists; the 9-character one (Favorites)
  now holds one item although `/me` still says `lists:0, favorites:0` — those counters cannot be
  trusted for lists. `GET /lists/<id>/items` →
  `{ listItems:[{ id:n, listId:n, type:"trail", order:n, notes:null|s, trailId:n, metadata:{status, created:dt, updated:dt} }], meta }`.
  The item carries **only the trail's id**. Other item types (a saved recording or custom route)
  were not observed — favouriting from a recording saved the _trail_, not the recording.
- **Trail lookup**: `GET /trails/<id>` → `{ trails:[{ id, versionId, name, slug, overview, routeType, popularity, location:{…, latitude:n, longitude:n}, attributes, defaultActivityStats, trailGeoStats, defaultPhoto, defaultMap, avgRating, source, … }] }`.
  `slug` is `country/region/name` (three segments), so the page is
  `https://www.alltrails.com/trail/<slug>`. Only `name`, `slug`, `id` and `location` may be kept;
  `overview`, `defaultMap` and the rest are AllTrails' content.
- Neither recording had a `trailId`; recordings are not tied to a platform trail by default.

### Native GPX

Not found. `/maps/<id>/export`, `/download`, `/files`, `/gpx` all return `method_not_found`;
`/maps/<id>.gpx` ignores the extension and returns JSON. The only `gpx` endpoint in the loaded
bundles is `/api/alltrails/maps/gpx`, which is the **upload** form. The account is on the free
tier and the site shows a "Start free trial" prompt, so file download may be a paid feature whose
code only loads for subscribers. The adapter should plan to build GPX from the decoded polyline
and treat a native file as a bonus.

### Asset hosts

None observed — the account has no photos. `cdn-assets.alltrails.com` serves site JavaScript, not
user photos. `images.alltrails.com` in `src/adapters/hosts.ts` is unverified.

### Still unknown (needs an account with data, ideally a subscriber)

- list items other than `type:"trail"`, custom and collaborative lists, completed trails, reviews
- whether the photo file is the original upload; photos on platform trails
- what a signed-out browser gets (a cookie-less `fetch` got a 403 JSON `{url}` bot challenge)
- maximum `limit` (500 was accepted)
- native GPX/KML download endpoint
- `mapPhotos` entries and `indexedHeartRateData`

## Strava (`https://www.strava.com`)

Probed 2026-09-21 from a signed-in session, same-origin `fetch`, same notation as above. The
account holds 592 activities (5 without GPS), 21 routes and 288 photos. Strava's public REST API
(`/api/v3/…`) wants an OAuth token and answers `401` to a cookie session, so everything below is
the site's own web endpoints.

**What a Strava account holds.** Activities (recordings) and routes (planned) are the user's
geodata. There are no waypoints, areas or folders. Routes the user starred from other athletes
are saved content. Segments are platform content and are not exported.

### Session and request shape

- Cookie session. The JSON listings answer with the **HTML page** unless the request carries
  `X-Requested-With: XMLHttpRequest`; `Accept: application/json` alone is not enough. With that
  header, a signed-out request gets `401` with an empty `application/json` body.
- GPX exports need no extra header. Signed out, they redirect to `/login`.
- `/robots.txt` is 1.6 KB of text, a good parking page. Every call below, both POSTs included,
  works from it with `referrerPolicy: 'no-referrer'`.

### Account — `GET /frontend/athletes/current`

`{ currentAthlete: { id:n, id_str:s7, external_identity_hash:s64, super_user:b, firstname, lastname, gender, athlete_type:n, is_subscriber:b, subscription_platform:n, product_access:n, is_trial_eligible:b, profile_medium:url, measurement_units:s6, features:{}, experiments:{}, preferences:{…}, in_preview:b, num_days_remaining_in_preview:null, dob_required:b, age:n }, pageContext:{…} }`.
Signed out it still answers `200`, with `currentAthlete: null` and sign-in URLs in
`pageContext.authenticationData`. This is what the dashboard loads.

### Activities — `GET /athlete/training_activities?page=<n>&per_page=<n>` (XHR)

`{ models:[20x Activity], page:n, perPage:n, total:n }`. **`per_page` is capped at 20**: 200 and
500 both came back as `perPage: 20`. An empty page follows the last one.

Activity: `id:n, id_str:s11, name, sport_type, display_type, activity_type_display_name, private:b, bike_id, athlete_gear_id, start_date:s, start_date_local_raw:n, start_time:dt<0000-00-00T00:00:00+0000>, start_day, distance:s, distance_raw:n, long_unit, short_unit, moving_time:s, moving_time_raw:n, elapsed_time:s, elapsed_time_raw:n, trainer:b, static_map:url, has_latlng:b, commute:b, elevation_gain:s, elevation_unit, elevation_gain_raw:n, description:null|s, activity_url:url, activity_url_for_twitter:url, twitter_msg:s, is_changing_type:b, suffer_score:n, tags:{…}, selected_tag_type, flagged:b, hide_power:b, hide_heartrate:b, visibility:s, embeddable:b`.

- `start_time` is UTC written as `+0000`, which is not RFC 3339. `start_date_local_raw` is local
  wall time dressed up as epoch seconds; it differed from `start_time` by the local offset.
- Checked against streams: `distance_raw` is metres (equal to the last `distance` stream value),
  `elapsed_time_raw` is seconds (equal to the last `time` value), and `elevation_gain_raw` is
  metres (a smoothed gain, 0.93× the raw altitude sum).
- `visibility` was `everyone` or `only_me` (`private: true` on the latter); `followers_only` is
  the site's third setting and was not observed. Names and descriptions come unescaped
  (`&`, `<` appear raw); descriptions may contain newlines.
- `has_latlng: false` on indoor sessions (trainer rides and runs, pool swims). `VirtualRide`
  activities do have GPS.
- No owner field: the listing is the signed-in athlete's own activities.

### Activity geometry

- **Native GPX:** `GET /activities/<id>/export_gpx` → `200`, `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment`, no `Content-Length`. GPX 1.1, `creator="StravaGPX"`,
  namespaces `gpxtpx` (TrackPointExtension v1) and `gpxx`:
  `gpx > metadata > time; trk > name, type, trkseg (one) > trkpt[lat,lon] > ele, time, extensions > power, gpxtpx:TrackPointExtension > gpxtpx:hr, gpxtpx:cad`.
  The file is large: 3.2 MB for a 10 k-point run. No `desc`. An activity without GPS **redirects
  to `/dashboard`** (a 200 HTML page), not to an error.
- `export_original` returns the uploaded file (FIT here) and `export_tcx` a TCX. Neither is used.
- **Streams (fallback):** `GET /activities/<id>/streams?stream_types[]=latlng&stream_types[]=altitude&stream_types[]=time`
  → `{ latlng:[Nx [lat,lng]], altitude:[Nx n], time:[Nx n] }`. These are parallel arrays of equal
  length, same N as the GPX. `time` is seconds from the start (`0, 1, 2…`). Without GPS `latlng`
  is simply absent. It answers JSON with or without the XHR header. `distance`, `moving`,
  `heartrate` are available too.
- `/activities/<id>.json` and `/overview` answer `application/json` with an HTML body. No JSON
  activity detail was found; the listing has everything needed.

### Routes — POST only

The routes page (`/athlete/routes`, a Next.js page) lists routes with
`POST /api/next/data/routes/my-routes`. `GET` → `405`. No GET listing exists. These were tried:
`/athletes/<id>/routes`, `/athlete/routes.json`, `/athlete/routes?format=json`, the Next.js
`__NEXT_DATA__` (no routes in it), `/_next/data`, the profile and dashboard HTML (no route ids),
and the route bundle's endpoint strings. The public `/api/v3/…` needs OAuth.

- The POST needs an `x-csrf-token` header. The token comes from
  **`POST /api/next/mint-csrf-token`** (no body, no headers) → `{ token:s86 }`. A `GET` there is
  `405 {error}`. The Rails `<meta name="csrf-token">` on older pages is a different token and
  gets a `500`.
- The token is **bound to the session**: one minted with `credentials: 'omit'` is refused. Several
  minted in a row are all valid at once. Without it, with a wrong one, or signed out: `403`
  with an empty body.
- Body: `{ pageSize:n, after:s, searchArgs:{ query:s, onlyStarred:b, createdBy:"Any", routeTypes?:[…], elevGainMin:n, elevGainMax:null, distanceMin:n, distanceMax:null }, resolutions:[{height,width,isRetina}] }`.
  Without `searchArgs` → `500`. `createdBy` other than `"Any"` (`"Me"`) → `500`. **Omitting
  `routeTypes` (or `null`) applies no type filter.** The page itself sends all 31 type names,
  so a type added later would be missed that way. An empty list gives nothing and an unknown
  name gives `500`. `resolutions: []` just drops the map thumbnails.
- Response: `{ me:{ id:s7, measurementPreference:s, searchRoutes:{ nodes:[Route], pageInfo:{ endCursor:s, startCursor:s, hasNextPage:b, hasPreviousPage:b } } } }`.
  Route: `title, id:s19, isStarred:b, elevationGain:n, length:n, estimatedTime:{expectedTime:n}, creationTime:dt<…Z>, themedMapImages:[{lightUrl:url}], routeType:s, athlete:{id:s7}, isPrivate:b`.
  **Route ids are 19-digit strings, past 2^53**: they must never go through a JS number.
  `length` is metres. There is no description in the node.
- Paging: `after:"0"` for the first page, then the previous `endCursor`. The cursor is the
  0-based index of that page's last item (pages of 5 gave `4, 9, 14, 19`). `pageSize: 50` and
  `200` returned all 21.
- All 21 routes were the account's own, and all starred. Whether other athletes' starred routes
  appear here (with another `athlete.id`) is **unverified**. The adapter treats them as
  references if they do.

### Route geometry

`GET /routes/<id>/export_gpx` → `200 application/octet-stream`, private routes included.
`gpx > metadata > name, author > name, link; copyright > year, license; link` and
`trk > name, link, type, trkseg > trkpt[lat,lon] > ele`, with **no times**. `/routes/<id>/export_tcx`
also works. There is no JSON geometry to fall back on: the route page's `__NEXT_DATA__` has legs
as encoded polylines, but only inside HTML.

### Photos — `GET /athletes/<id>/photos?per_page=<n>&cursor=<c>` (XHR)

`{ items:[Photo], next_cursor:s ("<epoch>,<id>"), has_more:b }`. The default page is 10;
`per_page` is capped at 20. `cursor=<next_cursor>` pages; `page`, `before`, `after` and `offset`
are ignored (first page again), and an unknown cursor gives an empty page. All 288 photos came
back over 15 pages, with no repeats.

Photo: `photo_id:s36 (UUID), id:n, media_type:n (1), activity_id:n, activity_id_str:s11, post_id:null, activity_name_escaped:s, caption_escaped:s (HTML-escaped), thumbnail:url, large:url, video:null, duration:null, lat:null, lng:null, native:b, owner_id:n, viewing_athlete_id:n, editable:b, activity:{ id, id_str, athlete_id, athlete_id_str, name, description, elapsed_time, moving_time, elev_gain, distance, type, private:n, start_date:dt<…Z> }, dimensions:{ large:{height,width}, thumbnail:{height,width} }, is_sponsored_photo:b, enhanced_photo:null`.

- `lat`/`lng` were null on every listed photo, though the activity page's own photo list has
  them. There is no upload or capture time.
- `/activities/<id>/photos` (with or without `photo_sources=true`) is `404`. An activity's photos
  are otherwise only in its HTML page (`data-react-props` of `MediaThumbnailList`).
- **Photo files** live on `https://dgtzuqphqg23d.cloudfront.net/<token>-<W>x<H>.jpg`. The URL is
  unsigned (no query) and needs no session. The host sends **no CORS headers** (a page `fetch`
  fails and `<img>` loads), so the extension worker needs a host permission for it. `large` was
  named `-1536x2048` and delivered 1200×1600, so it is the largest rendition offered, not
  necessarily the upload. Other sizes in the name (`-0x0`, bare `.jpg`, larger) do not exist.
- Videos (`media_type` ≠ 1, `video` set) are unobserved. The adapter skips any item with a
  `video`.

### Signed out

`/frontend/athletes/current` → `200 { currentAthlete: null }`. XHR listings and streams → `401`
with an empty body. GPX exports → `302 /login` → HTML. The routes query → `403` empty. The mint
still answers `200 { token }` with a token no session accepts.

### Still unknown for Strava

- other athletes' routes in the routes query; `followers_only` activities; video items in the
  photo listing
- rate limits on the GPX exports (3 MB each; the adapter paces at 500 ms, one at a time)
- whether `large` is ever the original upload

## Still unknown for Gaia

- saved hikes / public-trail references inside folders; multi-ring or multi-polygon areas
- shared folders and other users' objects (`is_shared`, `access`, `writable` values)
- photo `Content-Type` variety (PNG/HEIC), rate limits
- waypoint elevation exists only on the detail (`properties.elevation`); the adapter exports
  waypoints from the listing alone, so **elevation is currently dropped** — one request per
  waypoint would recover it
- whether `…/image/full/` works without a session for every photo, and the sign-in URL the site
  redirects anonymous visitors to
