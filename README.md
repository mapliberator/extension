# MapLiberator

A browser extension (Chrome MV3 + Firefox MV3) that exports your own routes, tracks, waypoints,
areas, folders and photos from outdoor mapping services into an open, portable ZIP archive — the
[Portable Map Archive](spec/portable-map-archive-1.0-draft.md). Everything happens locally in the
browser. The extension makes no network requests to MapLiberator infrastructure, requests no
`cookies` permission, and has no telemetry.

Product requirements: [`prd-v2.md`](prd-v2.md). Definition of done: [`goal.md`](goal.md).

## Verify

```sh
npm ci && npm run verify        # ~1–2 min
npm run verify:large            # slow; needs ~20 GB free disk
```

`verify` runs, and fails if any of these fail:

| Stage  | What                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STATIC | `tsc --noEmit` (strict) for the extension and for tools/tests, `svelte-check`, `prettier --check .`, Vitest unit suites, and a guard against skipped / todo / focused tests                       |
| BUILD  | `wxt zip` and `wxt zip -b firefox` (build + store zips), `web-ext lint` on the Firefox build, manifest assertions for both builds (`tests/build/manifest.test.ts`)                                |
| E2E    | Playwright + Chromium with the extension loaded, against `tools/fake-source`: happy path for every source, fault injection, schema drift, cancel, crash-leftover sweep, concurrent-export refusal |

`verify:large` exports a synthetic 5.5 GB photo-heavy account through the OpfsSink and the
DirectFileSink and asserts a valid Zip64 archive, stored photos, and a peak JS heap (page + worker)
under 512 MB.

## Layout

```text
src/
  entrypoints/   background (opens the export page, nothing else) · popup · export page
                 source-executor (injected into the source tab) · exporter-worker
  engine/        run orchestration · pacing/retry/pause · source-tab bridge · state machine
  adapters/      gaia/ · alltrails/ · strava/ — schemas, mappers, fixtures; hosts.ts is the host
                 and POST-path allowlist
  archive/       zip · gpx · gpx-check · geojson · sidecar · collections · manifest · filenames · scrub
  sinks/         OpfsSink (universal) · DirectFileSink (File System Access fast path) · select
  shared/        normalized models · archive zod schemas · error taxonomy
spec/            Portable Map Archive 1.0-draft + JSON Schemas generated from the zod schemas
tools/
  pma-validate/  validator CLI + reference reader — imports nothing from src/
  fake-source/   synthetic Gaia-/AllTrails-/Strava-shaped server with fault injection (see API.md)
tests/           Vitest: unit suites, spec independence, schema drift guard, build assertions
e2e/             Playwright specs
```

Useful scripts: `npm run dev` / `dev:firefox`, `npm run fake-source`, `npm run pma-validate --
archive.zip --tree`, `npm run spec:generate`, `npm run fixtures:generate`.

## Website

mapliberator.com lives in [mapliberator/web](https://github.com/mapliberator/web). Its build
clones this repository and renders `spec/` at `/spec/`, with each JSON Schema at the URL its `$id`
names. Its tests check that every `mapliberator.com` URL in `src/` and `spec/` resolves, so a new
URL here needs a page there. The site does not rebuild on its own: redeploy it after pushing a
spec change.

## Requests to the platforms

The source tab sends GET requests, plus POST to the exact paths a source allowlists in
`src/adapters/hosts.ts` (`postPaths`). Only Strava has any: it lists routes only through a POST
carrying a CSRF token that another POST mints. The transport mints that token again for each
attempt, so it never outlives one request, and adapters never see it.

## The e2e build

`wxt build --mode e2e` differs from production in exactly three ways:

1. `src/adapters/hosts.ts` swaps the real platform hosts for `*.localhost:4610`
   (`tools/fake-source`). Production bundles tree-shake the fake hosts out; a build test checks it.
2. Those hosts are also listed under `host_permissions`. The browser's permission prompt cannot
   be driven by Playwright; the production manifests list hosts **only** as optional, which the
   manifest test asserts for both browsers.
3. `src/engine/timings.ts` shortens retry backoff and pause cooldowns so fault runs take seconds.
   Concurrency and the pacing floor — which the e2e suite measures server-side — are unchanged.

The e2e suite removes `window.showSaveFilePicker` before extension pages load, so feature
detection selects the OpfsSink exactly as it does on Firefox. The native picker cannot be
automated; `verify:large` stubs it with a real `FileSystemFileHandle` to drive the DirectFileSink.

## Not covered by `verify` — still to be done by hand

- **Phase 0 platform probes.** All three platforms have been probed (`docs/phase0-findings.md`)
  and the adapters, fixtures, fake server and hosts follow the recorded shapes. Still open — Gaia:
  shared folders, waypoint elevation (only on the per-waypoint detail). AllTrails: **the
  `X-AT-KEY` app key is not configured** (`src/adapters/alltrails/key.ts`; the adapter refuses to
  run without it — ship it or read it from the site at run time is an open decision), completed
  trails and reviews, list items other than saved trails, and what a signed-out browser gets.
  Strava: other athletes' starred routes in the routes query, followers-only activities, videos
  in the photo listing, and rate limits on the GPX exports are unobserved.
- **Firefox end to end.** Only the build, `web-ext lint` and the manifest assertions are
  automated. The export flow in Firefox — `persist()` and quota, the OPFS → `downloads` hand-off,
  the optional-permission prompt — stays on the manual checklist (PRD §24).
- **Phase 6**: store listings, deploying the website (mapliberator/web), licence choice for the
  spec (CC-BY vs CC0; the code is MIT, see `LICENSE`), legal review, and the real-account smoke
  test on both browsers.
