/**
 * Scrubs `source.raw` before it is written (PRD §8.5): credentials, session material, e-mail
 * addresses and other people's personal details never reach the archive.
 */

/** Substrings that condemn a key, compared after lowercasing and removing `_`/`-`. */
const SENSITIVE_KEY_PARTS = [
	'email',
	'token',
	'csrf',
	'xsrf',
	'session',
	'cookie',
	'password',
	'passwd',
	'secret',
	'auth',
	'apikey',
	'signature',
	'credential',
	'phone'
];

/** Whole keys that describe people rather than map data. */
const PERSON_KEYS = [
	'user',
	'users',
	'owner',
	'creator',
	'author',
	'username',
	'userdisplayname',
	'sharedby',
	'sharedwith',
	'collaborators',
	'invitees'
];

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string, extraKeys: readonly string[] = []): boolean {
	const normalized = normalizeKey(key);
	if (PERSON_KEYS.includes(normalized)) return true;
	if (extraKeys.some((extra) => normalizeKey(extra) === normalized)) return true;
	return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/** Returns a deep copy with sensitive keys dropped and e-mail addresses redacted from strings. */
export function scrubRaw(value: unknown, extraKeys: readonly string[] = []): unknown {
	if (typeof value === 'string') return value.replace(EMAIL_PATTERN, '[redacted]');
	if (Array.isArray(value)) return value.map((item) => scrubRaw(item, extraKeys));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (isSensitiveKey(key, extraKeys)) continue;
			out[key] = scrubRaw(child, extraKeys);
		}
		return out;
	}
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
	return undefined;
}
