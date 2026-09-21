/**
 * Generates spec/schemas/*.schema.json from the zod schemas in src/shared/schemas.ts, so the
 * published spec and the extension cannot drift. `tests/spec-schemas.test.ts` fails when the
 * committed files differ from a fresh generation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SPEC_SCHEMAS } from '../src/shared/schemas.ts';

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'schemas');
const BASE_ID = 'https://mapliberator.com/spec/1.0-draft/schemas';

export function generateSpecSchemas(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, schema] of Object.entries(SPEC_SCHEMAS)) {
		const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
		const doc = { $id: `${BASE_ID}/${key}.schema.json`, ...json };
		out[`${key}.schema.json`] = JSON.stringify(doc, null, '\t') + '\n';
	}
	return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	mkdirSync(SCHEMA_DIR, { recursive: true });
	for (const [name, content] of Object.entries(generateSpecSchemas())) {
		writeFileSync(join(SCHEMA_DIR, name), content);
		console.log(`spec/schemas/${name}`);
	}
}
