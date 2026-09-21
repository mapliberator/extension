# Portable Map Archive — specification

This directory is the home of the **Portable Map Archive** format: a ZIP of GPX, GeoJSON, JSON and
original photo bytes that holds one person's map data, exported from one platform, in a form any
other tool can import.

| File                                                                     | What it is                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`portable-map-archive-1.0-draft.md`](portable-map-archive-1.0-draft.md) | The specification, version `1.0-draft`.                                                     |
| [`schemas/`](schemas/)                                                   | JSON Schemas (draft 2020-12) for every JSON document in an archive. Normative.              |
| [`LICENSE.md`](LICENSE.md)                                               | The specification's own license, separate from the license of the MapLiberator source code. |

## Versions

- The **specification** has its own version, currently `1.0-draft`. It will be frozen as `1.0` once an
  independent implementation has consumed it.
- **Archives** carry an integer major version (`"version": 1` in `manifest.json`). Draft and final
  1.x archives both say `1`.

## The schemas are generated

`schemas/*.schema.json` are generated from the writer's own runtime schemas by
`scripts/generate-spec-schemas.ts`, and a test fails when the committed files differ from a fresh
generation, so the published schemas and the reference writer cannot drift apart. Do not edit them by
hand.

## Conformance tool

[`tools/pma-validate`](../tools/pma-validate/) validates an archive against this specification and
includes a ~100-line reference reader. It is written strictly from this directory and imports nothing
from the extension; a test enforces that. If you are writing an importer, start by reading
"Reading an archive" (§14) and `tools/pma-validate/reader.ts`.

## Changelog

- `1.0-draft` — initial public draft.
