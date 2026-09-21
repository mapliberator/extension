# pma-validate

Conformance checker and reference reader for the
[Portable Map Archive 1.0-draft](../../spec/portable-map-archive-1.0-draft.md).

```sh
npx tsx tools/pma-validate/cli.ts <archive.zip> [--tree] [--json]
```

Exit status: `0` valid · `1` invalid · `2` usage or I/O error.

- `--tree` prints the object tree with the reference reader: collections → members → references →
  photo attachments, then un-collected objects, then unattached photos.
- `--json` prints the whole `ValidationResult` (errors, warnings, manifest, entries, counts, zip64).

Error and warning codes are listed in §15 of the specification.

## Rules of this folder

This tool is written **strictly from `spec/`** — the document and `spec/schemas/*.json` — and must
import nothing from the extension's `src/`, directly or transitively
(`tests/spec-independence.test.ts` enforces it). If something here cannot be written without peeking
at the extension, the specification has a hole: fix the specification. Allowed dependencies: Node
built-ins, `yauzl`, `ajv`, `saxes`.

## Files

| File                         | Purpose                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `validate.ts`                | `validateArchive(path): Promise<ValidationResult>`. Random access + streaming; photo bytes are never read; fine for > 5 GB Zip64. |
| `reader.ts`                  | `readArchiveTree(path): Promise<string>`. The ~100-line reference reader (spec §14).                                              |
| `zip.ts`                     | yauzl plumbing, CRC checks, Zip64 detection.                                                                                      |
| `cli.ts`                     | Command line.                                                                                                                     |
| `fixtures/build-fixtures.ts` | `buildFixtures(dir)`: writes one valid, one partial and ~20 invalid archives, using its own tiny ZIP writer (`zip-writer.ts`).    |
