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
| E2E    | Playwright + Chromium with the extension loaded, against `tools/fake-source`: happy path for both sources, fault injection, schema drift, cancel, crash-leftover sweep, concurrent-export refusal |

`verify:large` exports a synthetic 5.5 GB photo-heavy account through the OpfsSink and the
DirectFileSink and asserts a valid Zip64 archive, stored photos, and a peak JS heap (page + worker)
under 512 MB.

## Layout

```text
src/
  entrypoints/   background (opens the export page, nothing else) · popup · export page
                 source-executor (injected into the source tab) · exporter-worker
  engine/        run orchestration · pacing/retry/pause · source-tab bridge · state machine
  adapters/      gaia/ · alltrails/ — schemas, mappers, fixtures; hosts.ts is the host allowlist
  archive/       zip · gpx · gpx-check · geojson · sidecar · collections · manifest · filenames · scrub
  sinks/         OpfsSink (universal) · DirectFileSink (File System Access fast path) · select
  shared/        normalized models · archive zod schemas · error taxonomy
spec/            Portable Map Archive 1.0-draft + JSON Schemas generated from the zod schemas
tools/
  pma-validate/  validator CLI + reference reader — imports nothing from src/
  fake-source/   synthetic Gaia-/AllTrails-shaped server with fault injection (see API.md)
tests/           Vitest: unit suites, spec independence, schema drift guard, build assertions
e2e/             Playwright specs
```

Useful scripts: `npm run dev` / `dev:firefox`, `npm run fake-source`, `npm run pma-validate --
archive.zip --tree`, `npm run spec:generate`, `npm run fixtures:generate`.

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

- **Phase 0 platform probes** against the real Gaia GPS and AllTrails with a signed-in session.
  The response shapes in `tools/fake-source`, the adapter schemas, the fixtures in
  `src/adapters/*/fixtures/` and the asset hosts in `src/adapters/hosts.ts` are plausible
  inventions until those findings exist. Expect a correction pass confined to `src/adapters/`.
- **Firefox end to end.** Only the build, `web-ext lint` and the manifest assertions are
  automated. The export flow in Firefox — `persist()` and quota, the OPFS → `downloads` hand-off,
  the optional-permission prompt — stays on the manual checklist (PRD §24).
- **Phase 6**: store listings, website, licence choice for the spec (CC-BY vs CC0; the code
  is MIT, see `LICENSE`), legal review, and the real-account smoke test on both browsers.
