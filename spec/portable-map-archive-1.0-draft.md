# Portable Map Archive

**Specification version:** `1.0-draft`\
**Archive major version:** `1` (the value of `version` in `manifest.json`)\
**Status:** Draft. It will be frozen as `1.0` only after an independent implementation has consumed it. Archives carry `"version": 1` either way.\
**License:** see [LICENSE.md](LICENSE.md).

A Portable Map Archive (PMA) is a ZIP file holding one person's own map data — recorded tracks, planned routes, waypoints, areas, photos, and the collections that organize them — exported from **one** source platform, in formats that existing tools already read (GPX 1.1, GeoJSON, JSON, original photo bytes).

The format is designed so that:

- the interesting parts open in ordinary software with no knowledge of this document (unzip it; drag a `.gpx` into any map application);
- a writer can produce it as a single forward-only stream with bounded memory;
- a reader can import it completely — relationships included — from this document and the JSON Schemas in [`schemas/`](schemas/) alone.

## 1. Conventions

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

- **Writer** — software that produces an archive. **Reader** (or _importer_) — software that consumes one. **Validator** — software that checks conformance (§15).
- **Entry** — one file record in the ZIP container. **Entry name** — its full path inside the container, e.g. `tracks/000001-morning-ridge-run.gpx`.
- **Object** — one exported thing of one of six **types**: `track`, `route`, `waypoint`, `area`, `photo`, `collection`. The plural forms `tracks`, `routes`, `waypoints`, `areas`, `photos`, `collections` are used as directory names and as keys in the manifest.
- **Line object** — a track or a route.
- **Finished archive** — an archive that contains `manifest.json`. Everything in this document that says "an archive MUST …" describes finished archives.

### 1.1 Normative schemas

The JSON documents in an archive are defined by JSON Schema (draft 2020-12) files published with this document:

| Document                                         | Schema                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `manifest.json`                                  | [`schemas/manifest.schema.json`](schemas/manifest.schema.json)           |
| `tracks/*.json`, `routes/*.json` (line sidecars) | [`schemas/line-sidecar.schema.json`](schemas/line-sidecar.schema.json)   |
| `photos/*.json` (photo sidecars)                 | [`schemas/photo-sidecar.schema.json`](schemas/photo-sidecar.schema.json) |
| `waypoints/waypoints.geojson`                    | [`schemas/waypoints.schema.json`](schemas/waypoints.schema.json)         |
| `areas/areas.geojson`                            | [`schemas/areas.schema.json`](schemas/areas.schema.json)                 |
| `collections.json`                               | [`schemas/collections.schema.json`](schemas/collections.schema.json)     |
| `errors.json`                                    | [`schemas/errors.schema.json`](schemas/errors.schema.json)               |

Each document MUST validate against its schema. The schemas deliberately allow additional properties everywhere (§13). Where this text and a schema disagree about the shape of a document, the schema wins and the disagreement is a bug in this text; rules that JSON Schema cannot express (cross-document references, counts, ordering) are defined only in this text.

## 2. Container

### 2.1 ZIP

An archive is a single ZIP file (PKWARE APPNOTE 6.3.x) with the file extension `.zip`. There is no special media type, magic entry, or archive comment.

- The archive MUST NOT be split or spanned across multiple files, and MUST NOT be encrypted, in whole or in part.
- Each entry MUST use compression method `0` (stored) or `8` (deflate). No other method is allowed.
- Writers MAY use data descriptors (general-purpose bit 3), which forward-only streaming writers need. Readers MUST therefore locate entries through the **central directory**, not by scanning local file headers.
- Entry names MUST be unique. Entry names MUST NOT differ from one another only by letter case, so that the archive extracts faithfully onto case-insensitive file systems.
- Explicit directory entries (names ending in `/`) MAY be present and carry no meaning. Readers MUST NOT require them.
- ZIP timestamps, permissions, comments and extra fields carry no meaning in this format.

### 2.2 Zip64

Writers MUST use Zip64 structures whenever the classic structures cannot represent the archive (any entry size or offset of 4 GiB or more, or more than 65,535 entries) and MAY use them at any time. Readers MUST support Zip64. Archives of tens of gigabytes are expected; readers SHOULD use random access and streaming rather than loading an archive into memory.

### 2.3 Names and text encoding

- Entry names MUST be encoded as UTF-8, and writers MUST set general-purpose bit 11 (the language-encoding flag) on every entry.
- Every text entry (`.json`, `.geojson`, `.gpx`) MUST be UTF-8. JSON entries MUST NOT start with a byte-order mark.

### 2.4 Compression

Text entries SHOULD be deflated. Photos and other already-compressed media SHOULD be stored (method `0`) so that they can be copied out without inflating. This is advice to writers, not a validity requirement; readers MUST accept either method for any entry.

## 3. Layout

```text
mapliberator-examplemaps-2026-09-21.zip
│
├── tracks/
│   ├── 000001-morning-ridge-run.gpx      one GPX file per recorded track
│   ├── 000001-morning-ridge-run.json     its sidecar
│   └── …
├── routes/
│   ├── 000001-mount-whitney-loop.gpx     one GPX file per planned route
│   ├── 000001-mount-whitney-loop.json    its sidecar
│   └── …
├── waypoints/
│   └── waypoints.geojson                 all waypoints, one FeatureCollection
├── areas/
│   └── areas.geojson                     all areas, one FeatureCollection
├── photos/
│   ├── 000001-summit.jpg                 original bytes
│   ├── 000001-summit.json                its sidecar
│   └── …
├── collections.json                      written after all objects
├── errors.json                           always present; [] when clean
└── manifest.json                         always the LAST entry
```

The name of the `.zip` file itself carries no meaning.

### 3.1 Representations

There is exactly one representation per object type; nothing is encoded twice.

| Object                              | Representation                                       |
| ----------------------------------- | ---------------------------------------------------- |
| Track (recorded activity)           | GPX 1.1, one file each, in `tracks/`, plus a sidecar |
| Route (planned line)                | GPX 1.1, one file each, in `routes/`, plus a sidecar |
| Waypoint                            | one Feature in `waypoints/waypoints.geojson`         |
| Area (polygon)                      | one Feature in `areas/areas.geojson`                 |
| Photo                               | original bytes in `photos/`, plus a sidecar          |
| Collection, references, annotations | `collections.json`                                   |

### 3.2 Which entries are present

In a finished archive:

- `manifest.json`, `collections.json` and `errors.json` MUST be present, even when they have nothing to say (`{"collections": []}` and `[]`).
- `waypoints/waypoints.geojson` MUST be present when at least one waypoint was exported, and `areas/areas.geojson` when at least one area was. Either MAY also be present with zero features. When the entry is absent there are zero objects of that type.
- `tracks/`, `routes/` and `photos/` contain entries only when such objects were exported.

### 3.3 Order of entries

"Order" means the order of records in the ZIP central directory, which for a conforming archive is also the order in which entries were written.

- `manifest.json` MUST be the last entry: the last record in the central directory **and** the entry with the greatest local-header offset.
- `collections.json` and `errors.json` MUST come after every object entry (everything under `tracks/`, `routes/`, `waypoints/`, `areas/` and `photos/`). Their order relative to each other is not significant.
- No other ordering is guaranteed. In particular a sidecar MAY come before or after the file it describes, photos MAY be interleaved with the objects they are attached to, and readers MUST NOT assume `manifest.json` is first.

These rules exist so that a writer can stream: objects are written as they are fetched, the relationship and error documents are written when everything is known, and the manifest seals the archive.

### 3.4 Unknown entries

Version 1.x defines only the names shown above: the three top-level documents, `waypoints/waypoints.geojson`, `areas/areas.geojson`, and direct children of `tracks/` (`*.gpx`, `*.json`), `routes/` (`*.gpx`, `*.json`) and `photos/` (any file, `*.json` being sidecars). Writers MUST NOT add other entries, MUST NOT nest subdirectories below the five object directories, and MUST use the lower-case extensions `.gpx`, `.json` and `.geojson` exactly.

Readers SHOULD tolerate and ignore entries they do not recognize, because a later 1.x revision may define more. Validators report them as warnings. Unsafe names (§4.2) are never tolerated.

## 4. Entry names

### 4.1 Importers MUST NOT parse file names

Object file names look like `<sequence>-<slug>.<ext>`, for example `000412-trail-camp.jpg`. The sequence keeps names unique and sorted; the slug is a sanitized, ASCII-folded rendering of the object's name, cut to roughly 60 characters, and falls back to the number alone when nothing survives sanitizing. All of this is a courtesy to humans browsing the unzipped folder.

**Readers MUST NOT parse file names.** They MUST NOT derive an ID, a type, a title, an ordering or a relationship from a file name. An object's identity and metadata come from its sidecar; the sidecar's `file` property says which sibling file holds the object. The only name-derived facts a reader uses are (a) the fixed names of §3 and (b) which of the five object directories an entry is in and whether its name ends in `.json`.

The file-name part (the last path segment) of every entry under `tracks/`, `routes/` and `photos/` MUST match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and MUST NOT be longer than 255 bytes. A photo's extension SHOULD reflect the media type the source reported (its `Content-Type`), not the source URL; readers MUST use the sidecar's `contentType`, not the extension.

### 4.2 Safe names

Every entry name in an archive — including names of entries a reader does not recognize — MUST satisfy all of the following. An archive containing a name that does not is **invalid**, and readers MUST reject it (or at the very least MUST NOT extract that entry).

1. It is not empty and is valid UTF-8.
2. It is relative: it does not begin with `/`.
3. It uses `/` as the only separator and contains no backslash (`\`) anywhere.
4. It does not begin with a drive letter (`^[A-Za-z]:`).
5. No path segment is `..`, `.`, or empty (no `//`). A single trailing `/` marks a directory entry and is allowed.
6. It contains no control characters (U+0000–U+001F, U+007F–U+009F).

Readers that extract to a file system SHOULD additionally apply their platform's own protections (reserved device names, symbolic links, maximum path lengths).

## 5. Identity

Every object has an **archive-local ID** of the form `<type>/<sequence>`:

```text
track/000001   route/000001   waypoint/000412   area/000003   photo/001877   collection/000003
```

- `<type>` is one of the six type names. `<sequence>` is a decimal number of **at least six digits**, zero-padded, assigned per type in the order the writer enumerated the source, starting at `000001`. The pattern is `^(track|route|waypoint|area|photo|collection)/[0-9]{6,}$`.
- IDs MUST be unique across the whole archive. An ID's type prefix MUST match the type of the object that carries it.
- IDs are opaque strings. Readers MUST compare them as strings, MUST NOT assume sequences are contiguous (objects that failed to export leave gaps, §12), and MUST NOT assume an ID means anything outside the archive it came from: exporting the same account twice may number things differently.
- **All relationships inside an archive use archive-local IDs and nothing else.**
- Identifiers from the source platform appear only as provenance, in `source.id` and `source.url`. Readers MAY use them for de-duplication heuristics but MUST NOT rely on them being unique, stable, or meaningful.

### 5.1 Resolving IDs

Three properties hold IDs that point at other objects: a collection member's `ref` (§9.2), a collection's `parent` (§9.1) and a photo's `attachedTo` (§10). Each such ID MUST resolve to either

1. an object **present** in the archive, or
2. an ID recorded in `errors.json` (§12) — the object was seen, numbered, and then failed to export.

Anything else is a **dangling reference** and makes the archive invalid. Readers MUST skip relationships of the second kind (treat the member as absent, the photo as unattached, the collection as top-level) and SHOULD tell the user the target was not exported.

An ID recorded in `errors.json` MUST NOT also be present as an object.

## 6. Tracks and routes — GPX conventions

- Each line object is one GPX 1.1 file: it MUST be well-formed XML whose root element is `gpx`. The root SHOULD be in the GPX 1.1 namespace `http://www.topografix.com/GPX/1/1` with `version="1.1"`, and the file SHOULD be valid against the GPX 1.1 schema; `serialized` files (§6.1) always are. Because `native-gpx` files are copied verbatim from platforms whose exporters are not always strict, readers SHOULD match GPX elements by local name and tolerate schema deviations.
- The file contains one or more `<trk>` and/or `<rte>` elements and MUST contain at least one `<trkpt>` or `<rtept>` in total. Every `<trkpt>` and `<rtept>` MUST have `lat` and `lon` attributes in decimal degrees within [−90, 90] and [−180, 180].
- **Kind does not come from the GPX.** Whether a line object is a track or a route is decided by its directory (`tracks/` or `routes/`) and its sidecar's `kind`, which MUST agree. A route MAY be encoded with `<trk>` and a track with `<rte>`; sources do both. Readers MUST treat the geometry as the concatenation-in-document-order of all `<trkseg>`/`<rte>` point lists, preserving segment breaks where they care about them.
- `<wpt>` elements MAY appear (sources embed them in native files). They are part of that line object's file, are not waypoint objects, have no ID, and readers MAY ignore them.
- Elevation (`<ele>`) is meters; `<time>` is RFC 3339 UTC (§13.1).
- **Readers MUST ignore GPX extensions they do not understand** (anything inside `<extensions>`, and any element or attribute in a foreign namespace) and MUST NOT fail because of them.
- The GPX `<name>`, `<desc>`, `<metadata>` and similar fields are informational. Where they disagree with the sidecar, the sidecar wins.

### 6.1 `geometrySource`

The sidecar says where the GPX bytes came from:

- `"native-gpx"` — the file is the source platform's own GPX export, byte for byte. It may carry vendor extensions, embedded waypoints, and whatever quirks that platform's exporter has. Writers MUST NOT rewrite it (beyond verifying that it satisfies this section).
- `"serialized"` — the writer built the GPX itself from the source's structured data. Such files SHOULD be plain GPX 1.1 without extensions.

Readers handle both identically; the property exists for provenance and debugging.

## 7. Waypoints and areas — GeoJSON conventions

`waypoints/waypoints.geojson` and `areas/areas.geojson` are each a single GeoJSON `FeatureCollection` per RFC 7946: WGS84, positions are `[longitude, latitude]` or `[longitude, latitude, elevationMeters]`, polygon rings are closed (first position equals last, at least four positions) and SHOULD follow the right-hand rule. No `crs` member.

- Each Feature's **`id` is the object's archive-local ID** (`waypoint/…` in the waypoints file, `area/…` in the areas file) and MUST be a string.
- Waypoint geometry is a `Point`. Area geometry is a `Polygon` or `MultiPolygon`.
- Each Feature's `properties` carries what a sidecar carries for line objects (§8.1): `name` (required), `source` (required), and optional `description`, `createdAt`, `updatedAt`, `visibility`, `tags`. Waypoints add an optional `icon` (the source's symbol name, uninterpreted). Areas add an optional `areaSquareMeters`.
- The order of features is the writer's enumeration order and carries no other meaning.

Waypoints and areas have no sidecars and no per-object files.

## 8. Sidecars

A **sidecar** is a small JSON document adjacent to (in the same directory as) an object file, carrying the object's ID and metadata. Sidecars exist for line objects and photos.

Pairing rules, for each of `tracks/`, `routes/` and `photos/`:

- Every entry in the directory whose name ends in `.json` is a sidecar. Every other entry is an object file (in `tracks/` and `routes/` it MUST end in `.gpx`).
- A sidecar's `file` property is the **file name only** (no directory) of a sibling entry, and that entry MUST exist.
- Every object file MUST be named by the `file` of **exactly one** sidecar in its directory, and every sidecar names exactly one object file. There are no orphan sidecars, no objects without sidecars, and no two sidecars describing the same file.
- Writers SHOULD give the sidecar the same base name as its object file (`x.gpx` ↔ `x.json`). Readers MUST pair through `file`, never through the name (§4.1).

### 8.1 Line sidecar

Schema: [`schemas/line-sidecar.schema.json`](schemas/line-sidecar.schema.json).

```json
{
	"id": "route/000001",
	"kind": "route",
	"file": "000001-mount-whitney-loop.gpx",
	"geometrySource": "native-gpx",
	"name": "Mount Whitney Loop",
	"description": "…",
	"createdAt": "2024-06-02T14:11:09Z",
	"updatedAt": "2025-01-18T03:40:51Z",
	"activityType": "hiking",
	"visibility": "private",
	"tags": [],
	"stats": { "distanceMeters": 35420.5, "ascentMeters": 1910, "pointCount": 4812 },
	"source": {
		"platform": "examplemaps",
		"id": "a1b2c3",
		"url": "https://maps.example.com/route/a1b2c3",
		"raw": {}
	}
}
```

| Property                 | Required | Meaning                                                                                                                                                                     |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | yes      | Archive-local ID, `track/…` or `route/…`.                                                                                                                                   |
| `kind`                   | yes      | `"track"` or `"route"`. MUST equal the type prefix of `id`, and MUST match the directory: `tracks/` → `track`, `routes/` → `route`.                                         |
| `file`                   | yes      | Name of the sibling GPX file.                                                                                                                                               |
| `geometrySource`         | yes      | `"native-gpx"` or `"serialized"` (§6.1).                                                                                                                                    |
| `name`                   | yes      | The user's title for the object; MAY be the empty string.                                                                                                                   |
| `stats`                  | yes      | `pointCount` (required, integer ≥ 0), and optional `distanceMeters`, `ascentMeters`, `durationSeconds`. As reported by the source or computed by the writer; informational. |
| `source`                 | yes      | Provenance: `platform` (required, non-empty), `id` (required), optional `url`, optional `raw`.                                                                              |
| `description`            | no       | Free text.                                                                                                                                                                  |
| `createdAt`, `updatedAt` | no       | Timestamps (§13.1).                                                                                                                                                         |
| `activityType`           | no       | The source's activity label, uninterpreted (`"hiking"`, `"ski-touring"`, …).                                                                                                |
| `visibility`             | no       | `"private"`, `"unlisted"`, `"public"`, or `null` when unknown.                                                                                                              |
| `tags`                   | no       | Array of strings.                                                                                                                                                           |
| `sha256`                 | no       | **Reserved** for a future 1.x revision; 1.0 writers do not write it and readers MUST NOT require it.                                                                        |

Optional properties MAY be absent or `null`; the two mean the same thing ("unknown or not applicable").

### 8.2 `source.raw`

`source.raw` is present only when the user asked for raw source data (`manifest.selection.rawSourceData` is `true`). It holds the source platform's own representation of the object, of any JSON shape, **scrubbed** by the writer: known-sensitive keys (e-mail addresses, tokens, session material, other people's personal details) are removed before writing. Readers MUST NOT depend on its shape. It exists so that nothing the user had is lost to an imperfect mapping.

## 9. Collections, references and annotations

Schema: [`schemas/collections.schema.json`](schemas/collections.schema.json). `collections.json` is one object with one required property, `collections`, an array.

```json
{
	"collections": [
		{
			"id": "collection/000003",
			"name": "Sierra 2025",
			"parent": "collection/000001",
			"source": { "id": "f-991", "url": "https://maps.example.com/folder/f-991" },
			"members": [
				{ "ref": "route/000001" },
				{ "ref": "waypoint/000412" },
				{
					"reference": {
						"name": "Kearsarge Pass Trail",
						"source": {
							"platform": "examplemaps",
							"id": "t-10233",
							"url": "https://maps.example.com/trail/kearsarge-pass"
						},
						"coordinate": [-118.37, 36.77]
					},
					"annotations": {
						"completedAt": "2025-08-03",
						"rating": 5,
						"review": "…",
						"notes": "…"
					}
				}
			]
		}
	]
}
```

### 9.1 Collections

A collection is a named, ordered list of members: a folder, a list, a trip — whatever the source calls it.

- `id` (required) is a `collection/…` ID. `name` (required) and `members` (required, possibly empty) complete the minimum. `description`, `createdAt`, `updatedAt` are optional.
- `parent` (optional) is the ID of the containing collection; absent or `null` means top-level. It MUST resolve per §5.1. The `parent` relation MUST NOT contain cycles. Collections MAY appear in the array in any order; a child MAY precede its parent.
- `source` is the collection's provenance and MAY be `null` or absent for a collection the writer synthesized (for example "Completed trails", gathered from a source that has no such folder).
- **Membership is many-to-many.** An object MAY be a member of any number of collections, or of none, and readers MUST NOT assume an object lives "inside" a collection: deleting a collection after import does not delete its members. Member order is the source's order and SHOULD be preserved.

### 9.2 Members

Each member is an object with exactly one of two shapes:

- **`{ "ref": "<archive-local ID>" }`** — a pointer to an object in this archive (§5.1). Any object type MAY be referenced; nesting of collections SHOULD nevertheless be expressed with `parent`, not with a `ref` to a collection.
- **`{ "reference": {…}, "annotations": {…} }`** — a pointer to something the user _saved but did not author_: a platform-curated trail, another user's public route.

### 9.3 References never carry geometry

An archive contains the user's own data. Content owned by the platform or by other users is recorded only as a **reference**:

- `name` (required) — its title at export time.
- `source` (required) — `platform`, `id`, and a `url` where it can be viewed.
- `coordinate` (optional) — a **single** position `[lon, lat]` or `[lon, lat, ele]`, typically the trailhead, so an importer can drop a pin.

A reference MUST NOT carry a line, polygon, point list, elevation profile, description text, photo, or any other copy of the third-party content. References have no archive-local ID and cannot be the target of `ref`, `parent` or `attachedTo`.

### 9.4 Annotations

`annotations` (optional, only alongside `reference`) holds what the _user_ added to the third-party item — this part is theirs: `completedAt` (an RFC 3339 full-date `YYYY-MM-DD` or a UTC timestamp), `rating` (number, on the source's own scale), `review`, `notes`. All are optional and nullable.

## 10. Photos

Schema: [`schemas/photo-sidecar.schema.json`](schemas/photo-sidecar.schema.json).

A photo is stored as the bytes the source served: not re-encoded, not resized, metadata (EXIF, XMP) not stripped. Writers MUST NOT alter photo bytes. Any media type is allowed (JPEG, PNG, HEIC, WebP, …; sources occasionally serve video); readers decide what they can display from `contentType`.

```json
{
	"id": "photo/000001",
	"file": "000001-summit.jpg",
	"contentType": "image/jpeg",
	"rendition": "original",
	"attachedTo": "waypoint/000412",
	"caption": "…",
	"takenAt": "2025-08-03T18:22:10Z",
	"uploadedAt": "2025-08-04T02:01:44Z",
	"coordinate": [-118.29, 36.57],
	"source": {
		"platform": "examplemaps",
		"id": "p-77",
		"url": "https://maps.example.com/photo/p-77"
	}
}
```

| Property                | Required | Meaning                                                                                                                                                                                          |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | yes      | `photo/…` ID.                                                                                                                                                                                    |
| `file`                  | yes      | Name of the sibling file holding the bytes (§8).                                                                                                                                                 |
| `contentType`           | yes      | Media type reported by the source for those bytes.                                                                                                                                               |
| `rendition`             | yes      | `"original"` when the bytes are the user's upload as the source stores it; `"largest-available"` when the source only offers derived renditions and this is the biggest.                         |
| `attachedTo`            | yes      | The archive-local ID of the object this photo belongs to, or **`null` for an unattached photo**. The property MUST be present. A non-null value MUST resolve per §5.1 and SHOULD NOT be a photo. |
| `source`                | yes      | Provenance, as in §8.1.                                                                                                                                                                          |
| `name`, `caption`       | no       | Title and caption text.                                                                                                                                                                          |
| `takenAt`, `uploadedAt` | no       | Timestamps (§13.1).                                                                                                                                                                              |
| `coordinate`            | no       | Position where the photo was taken, as the source records it.                                                                                                                                    |
| `sha256`                | no       | Reserved, as in §8.1.                                                                                                                                                                            |

A photo attaches to at most one object. The relationship is stored on the photo only; objects do not list their photos, so a reader that wants "photos of X" builds that index from the photo sidecars (§14). A photo entry MAY precede or follow the object it is attached to.

## 11. Manifest

Schema: [`schemas/manifest.schema.json`](schemas/manifest.schema.json).

```json
{
	"format": "portable-map-archive",
	"version": 1,
	"createdAt": "2026-09-21T16:30:00Z",
	"status": "partial",
	"part": { "index": 1, "of": 1 },
	"generator": { "name": "MapLiberator", "version": "1.0.0", "browser": "firefox" },
	"source": {
		"platform": "examplemaps",
		"adapterVersion": "1.0.0",
		"account": { "id": "u-123", "displayName": "Sam H." }
	},
	"selection": {
		"routes": "included",
		"tracks": "included",
		"waypoints": "included",
		"areas": "included",
		"collections": "included",
		"photos": "excluded",
		"rawSourceData": true
	},
	"contents": {
		"routes": 493,
		"tracks": 2184,
		"waypoints": 827,
		"areas": 12,
		"collections": 31,
		"photos": 0
	},
	"errors": { "routes": 0, "tracks": 3, "waypoints": 0, "areas": 0, "collections": 0, "photos": 0 }
}
```

### 11.1 The manifest seals the archive

`manifest.json` is written last (§3.3), after every other byte of content is known to be safely in the container. Therefore:

- **A ZIP without `manifest.json` is not a Portable Map Archive; it is an aborted export.** Readers MUST refuse to import it as an archive. (A user may still salvage individual files from it by hand.)
- Readers MUST NOT assume the manifest is the first entry and MUST find it through the central directory.

### 11.2 Properties

- `format` — always the string `"portable-map-archive"`. Readers MUST reject anything else.
- `version` — the integer **major** version of the format, `1` for this specification. **Readers MUST reject an archive whose `version` is anything other than a major version they implement** — for a reader of this specification, anything other than `1` — with a message that says so plainly, and MUST NOT attempt a best-effort import (§13.3).
- `createdAt` — when the archive was finished.
- `status` — `"complete"` if and only if `errors.json` is empty; otherwise `"partial"`. A partial archive is a valid archive: everything in it is good, and `errors.json` lists what is missing.
- `part` — reserved for multi-part exports. `index` and `of` are integers ≥ 1 with `index` ≤ `of`. **1.0 writers always write `{ "index": 1, "of": 1 }`.** A reader that meets `of` > 1 SHOULD warn that other parts exist and MAY import the part on its own; each part is a self-contained, valid archive.
- `generator` — `name` and `version` of the writing software, optional `browser` or other runtime hint.
- `source` — exactly one source platform per archive: `platform` (a short lower-case identifier such as `"gaiagps"`), `adapterVersion` (version of the writer's mapping for that platform), and `account` with the platform's `id` and `displayName` for the exported account.
- `selection` — what the user asked for: for each plural type, `"included"` or `"excluded"`, plus the boolean `rawSourceData`. Together with `contents` and `errors` it lets a reader tell apart _not requested_ (`excluded`), _requested but the user has none_ (`included`, 0 contents, 0 errors) and _requested but failed_ (errors > 0).
- `contents` — for each plural type, the number of objects of that type **present** in the archive. Each count MUST equal what is actually there: `.gpx` files in `tracks/` and in `routes/`, features in the two GeoJSON files (0 when the file is absent), object files in `photos/`, and entries of `collections.json`. References (§9.3) are not objects and are not counted.
- `errors` — for each plural type, the number of entries in `errors.json` with that `type`. Each count MUST equal the actual number.

### 11.3 What never appears

An archive MUST NOT contain, in the manifest or anywhere else the writer controls: the account's e-mail address, passwords, cookies, bearer or OAuth tokens, CSRF tokens, API keys, or any other credential or session material. `account.displayName` is the name the platform shows publicly for the user and MUST NOT be an e-mail address. (Photo bytes and native GPX bytes are copied verbatim and are the user's own content.)

## 12. `errors.json`

Schema: [`schemas/errors.schema.json`](schemas/errors.schema.json). Always present; a JSON array; `[]` when nothing failed.

```json
[
	{
		"type": "photo",
		"id": "photo/000212",
		"sourceId": "12345",
		"adapter": "examplemaps@1.0.0",
		"error": "HTTP 404"
	}
]
```

One entry per object that the writer saw at the source but could not export.

- `type` — the object's type (singular).
- `id` — the archive-local ID the object was given, or `null` if it failed before it was numbered. When non-null, its type prefix MUST equal `type`, it MUST be unique within `errors.json`, and it MUST NOT be the ID of a present object. These IDs are valid targets for §5.1.
- `sourceId` — the source platform's identifier, or `null` when unknown, so the user can look the object up.
- `adapter` — `"<adapter id>@<adapter version>"` of the code that failed, e.g. `"examplemaps@1.0.0"`.
- `error` — a short human-readable reason. It MUST NOT include credentials, tokens or full response bodies.

## 13. Units, encodings and versioning

### 13.1 Units and encodings

- Coordinates are WGS84 decimal degrees. JSON positions are in RFC 7946 order, `[longitude, latitude]` with an optional third element, elevation in meters. GPX uses its own `lat`/`lon` attributes.
- Elevation and ascent are meters. Distances are meters, areas are square meters, durations are seconds — SI throughout, whatever the source displays. Writers convert when mapping; readers never need to.
- Timestamps are RFC 3339 in UTC with the literal `Z` suffix, e.g. `2025-01-18T03:40:51Z`; fractional seconds are allowed; numeric offsets are not. The only non-timestamp date is `annotations.completedAt`, which MAY be a full-date.
- All text is UTF-8 (§2.3). JSON per RFC 8259. Writers SHOULD NOT emit duplicate object keys.
- Strings from the source (names, descriptions, captions) are stored as the source holds them. If the source's descriptions are HTML or Markdown, they are stored as such; readers SHOULD treat all strings as untrusted plain text unless they choose to sanitize and render.

### 13.2 Unknown properties

Within major version 1, every JSON object in every document MAY carry properties this specification does not define. **Readers MUST ignore properties they do not understand** and MUST NOT fail because of them. Writers SHOULD NOT invent properties casually; vendor-specific data belongs in `source.raw`.

### 13.3 Versioning policy

There are two version identifiers:

- The **archive major version** — the integer `version` in the manifest. It changes only when an existing reader would misread a new archive. Readers reject majors they do not implement (§11.2).
- The **specification version** — the version of this document (`1.0-draft`, later `1.0`, `1.1`, …). It is **not** written into archives.

Within a major version, later revisions of the specification MAY add optional properties, add new entry names (§3.4), add enum values only where this document says an enum is open, and tighten prose. They MUST NOT remove or rename anything, change the meaning of an existing property, add new required properties or entries, or otherwise invalidate an archive that was valid under an earlier 1.x. A reader written against 1.0 therefore reads every 1.x archive by ignoring what it does not know.

While the specification is `1.0-draft`, incompatible corrections may still be made; they will be listed in a changelog in the specification's README. After `1.0` is frozen they require major version 2.

## 14. Reading an archive

A complete importer can be written from this algorithm. The reference reader (§15) is a direct transcription in roughly a hundred lines.

1. **Open** the ZIP with random access and read the central directory. Do not extract to disk first. Check every entry name against §4.2; on any unsafe name, stop.
2. **Find `manifest.json`.** If there is none, stop: aborted export. Parse it. If `format` is not `"portable-map-archive"`, or `version` is not `1`, stop with a clear message.
3. **Read `errors.json`** into a set `failed` of its non-null `id`s (and keep the entries to show the user what is missing).
4. **Index objects** into a map from archive-local ID to object:
   - for each `*.json` entry directly under `tracks/` and `routes/`, parse the sidecar; the object's geometry is the sibling entry named by `file`; its kind is `kind`;
   - for each Feature in `waypoints/waypoints.geojson` and `areas/areas.geojson` (when present), the key is the Feature's `id`;
   - for each `*.json` entry directly under `photos/`, parse the sidecar; the bytes are the sibling entry named by `file`;
   - for each entry of `collections.json`, the key is `id`.
     Never look inside a file name for any of this.
5. **Link.**
   - For each photo with non-null `attachedTo`: if the target is in the index, attach the photo to it; if it is in `failed`, treat the photo as unattached.
   - For each collection: if `parent` is in the index, nest it there; if `parent` is absent, `null`, or in `failed`, it is top-level. Guard against cycles anyway.
   - For each member: `{ref}` in the index → a membership; `{ref}` in `failed` → skip; `{reference}` → a bookmark with a name, a URL, optionally one coordinate and the user's annotations. A reader with no concept of bookmarks MAY drop references, and SHOULD say so.
6. **Import geometry** by streaming each GPX through an XML parser, ignoring unknown extensions; GeoJSON features are already in hand.
7. **Report**: compare what you imported with `manifest.contents`; show `manifest.errors` / `errors.json` and `selection` so the user understands what the archive does and does not contain.

Objects that belong to no collection, and photos attached to nothing, are normal and MUST still be imported.

A reader that trusts its input less than this (it should) validates each JSON document against its schema first and treats any violation of §5.1 as a corrupt archive.

## 15. Conformance and `pma-validate`

An archive **conforms** to this specification if it satisfies every MUST in §§2–13. A writer conforms if every archive it finishes conforms. A reader conforms if it imports every conforming archive according to §14, ignores what §13.2 and §6 tell it to ignore, and rejects what §4.2, §11.1 and §11.2 tell it to reject.

`pma-validate` (in `tools/pma-validate/` of the MapLiberator repository) is the conformance tool. It is written strictly from this document and the schemas in [`schemas/`](schemas/) and shares no code with any writer; if something cannot be checked or read from this document alone, that is a defect in this document.

```text
pma-validate <archive.zip> [--tree] [--json]
exit status: 0 valid · 1 invalid · 2 usage or I/O error
```

It works by random access and streaming (archives larger than 5 GB are routine): JSON and GeoJSON documents are parsed, GPX files are streamed through a SAX parser, and **photo bytes are never read**. `--tree` runs the reference reader of §14 and prints collections → members → references → photo attachments, then un-collected objects, then unattached photos.

Problems are reported with stable codes. **Errors** make the archive invalid:

| Code                      | Rule                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-a-zip`               | §2.1 — the file is not a readable ZIP (or its central directory is corrupt).                                                                 |
| `unsafe-name`             | §4.2 — an entry name is absolute, contains `..`, a backslash, a drive letter, a control character, an empty or `.` segment, or is not UTF-8. |
| `duplicate-entry`         | §2.1 — two entries have the same name, or names differing only by case.                                                                      |
| `encrypted-entry`         | §2.1 — an entry is encrypted.                                                                                                                |
| `unsupported-compression` | §2.1 — an entry uses a method other than 0 or 8.                                                                                             |
| `manifest-missing`        | §11.1 — no `manifest.json`: aborted export. Validation stops here.                                                                           |
| `unsupported-format`      | §11.2 — `format` is not `"portable-map-archive"`. Validation stops here.                                                                     |
| `unsupported-version`     | §11.2 — `version` is not `1`. Validation stops here.                                                                                         |
| `manifest-not-last`       | §3.3 — `manifest.json` is not the last central-directory record, or not the entry with the greatest local-header offset.                     |
| `required-entry-missing`  | §3.2 — `collections.json` or `errors.json` is absent.                                                                                        |
| `entry-order`             | §3.3 — `collections.json` or `errors.json` precedes an object entry.                                                                         |
| `json-invalid`            | §2.3 — a JSON/GeoJSON entry is unreadable, not UTF-8, or not JSON.                                                                           |
| `schema`                  | §1.1 — a document violates its JSON Schema (also: `part.index` > `part.of`).                                                                 |
| `gpx-invalid`             | §6 — a `.gpx` entry is not well-formed XML, its root is not `gpx`, it has no `trkpt`/`rtept`, or a point lacks a valid `lat`/`lon`.          |
| `missing-sidecar`         | §8 — an object file in `tracks/`, `routes/` or `photos/` is not named by any sidecar.                                                        |
| `orphan-sidecar`          | §8 — a sidecar's `file` names no sibling entry.                                                                                              |
| `duplicate-sidecar`       | §8 — two sidecars name the same file.                                                                                                        |
| `kind-mismatch`           | §8.1, §12 — a sidecar's `kind` or ID type does not match its directory; an error entry's `type` does not match its `id`.                     |
| `duplicate-id`            | §5 — an ID is used twice, or an ID listed in `errors.json` is also present.                                                                  |
| `dangling-ref`            | §5.1 — a `ref`, `parent` or `attachedTo` resolves to neither a present object nor an `errors.json` ID.                                       |
| `collection-cycle`        | §9.1 — the `parent` relation has a cycle.                                                                                                    |
| `count-mismatch`          | §11.2 — `manifest.contents` or `manifest.errors` differs from what is actually in the archive.                                               |
| `status-mismatch`         | §11.2 — `status` is not `complete` exactly when `errors.json` is empty.                                                                      |

**Warnings** do not:

| Code                 | Meaning                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `unknown-entry`      | §3.4 — an entry (with a safe name) that 1.x does not define. Importers ignore it. |
| `compression-advice` | §2.4 — a photo is deflated rather than stored.                                    |
| `gpx-namespace`      | §6 — the GPX root element is not in the GPX 1.1 namespace.                        |
| `selection-mismatch` | §11.2 — a type marked `excluded` nevertheless has contents or errors.             |
| `multi-part`         | §11.2 — `part.of` is not 1.                                                       |
| `manifest-email`     | §11.3 — something in the manifest looks like an e-mail address.                   |

New codes may be added; existing codes keep their meaning.

## 16. Security considerations

- **Path traversal.** Entry names are attacker-controlled input to anyone who receives an archive from someone else. §4.2 is mandatory for that reason; extracting without checking is how "zip-slip" vulnerabilities happen.
- **Resource exhaustion.** Deflated entries can expand enormously. Readers SHOULD stream, SHOULD bound the size of JSON documents they buffer, and SHOULD verify sizes against the central directory.
- **XML.** Readers MUST NOT resolve external entities or DTDs when parsing GPX.
- **Untrusted strings.** Names, descriptions, captions and `source.url` values come from a third-party platform and, through it, possibly from other people. Do not render them as HTML without sanitizing; do not fetch URLs automatically.
- **Privacy.** An archive is a person's location history, with unstripped photo metadata. It contains no credentials (§11.3), but it is sensitive, and software handling it SHOULD say so when offering to upload or share one.

## 17. References

- PKWARE, _.ZIP File Format Specification_ (APPNOTE.TXT), version 6.3.x
- _GPX 1.1 Schema Documentation_, <https://www.topografix.com/GPX/1/1/>
- RFC 7946, _The GeoJSON Format_
- RFC 8259, _The JavaScript Object Notation (JSON) Data Interchange Format_
- RFC 3339, _Date and Time on the Internet: Timestamps_
- RFC 2119 and RFC 8174, _Key words for use in RFCs to Indicate Requirement Levels_
- JSON Schema, draft 2020-12, <https://json-schema.org/draft/2020-12/schema>
