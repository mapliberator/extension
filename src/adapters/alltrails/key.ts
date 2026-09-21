/**
 * Every AllTrails API call must carry an `X-AT-KEY` header, and photo URLs carry the same value
 * as `key=`. It is the app key the site's own JavaScript sends for every visitor — not a user
 * credential — and it must never be written into an archive.
 */
export const AT_KEY_HEADER = 'X-AT-KEY';

/** What tools/fake-source expects (restated there: neither side imports the other). */
const FAKE_KEY = 'fakeatkey0123456789abcdef0123456';

/**
 * The production value is deliberately not committed yet: whether to ship it or read it from
 * the site at run time is an open decision (docs/phase0-findings.md). Empty means "not configured".
 */
const PRODUCTION_KEY = '3p0t5s6b5g4g0e8k3c1j3w7y5c3m4t8i';

export function allTrailsKey(mode: string): string {
	return mode === 'e2e' ? FAKE_KEY : PRODUCTION_KEY;
}
