import { describe, expect, it } from 'vitest';
import { isSensitiveKey, scrubRaw } from '../src/archive/scrub.ts';

describe('scrubRaw', () => {
	it('drops credentials, session material and e-mail keys at any depth', () => {
		const raw = {
			id: 't1',
			title: 'Ridge run',
			user_email: 'me@example.test',
			csrf_token: 'abc',
			csrfToken: 'abc',
			'X-Auth-Token': 'abc',
			session_id: 's',
			sessionCookie: 'c',
			password: 'p',
			api_key: 'k',
			apiKey: 'k',
			client_secret: 's',
			nested: {
				accessToken: 't',
				authorization: 'Bearer x',
				keep: 1,
				deeper: [{ refresh_token: 'r', ok: true }]
			}
		};
		expect(scrubRaw(raw)).toEqual({
			id: 't1',
			title: 'Ridge run',
			nested: { keep: 1, deeper: [{ ok: true }] }
		});
	});

	it("drops other people's details", () => {
		const raw = {
			name: 'Shared trip',
			user: { id: 7, name: 'Someone Else' },
			owner: { name: 'Someone Else' },
			shared_by: { name: 'Someone Else', email: 'x@example.test' },
			sharedWith: [{ name: 'A' }],
			collaborators: ['B'],
			user_id: 'gu-1001'
		};
		expect(scrubRaw(raw)).toEqual({ name: 'Shared trip', user_id: 'gu-1001' });
	});

	it('honours adapter-specific keys, ignoring case and separators', () => {
		const raw = { saved_hikes: [{ description: 'platform text' }], savedHikes: 1, title: 'x' };
		expect(scrubRaw(raw, ['saved_hikes'])).toEqual({ title: 'x' });
	});

	it('redacts e-mail addresses inside string values', () => {
		expect(scrubRaw({ notes: 'ask jo.bloggs+maps@example.co.uk about the key' })).toEqual({
			notes: 'ask [redacted] about the key'
		});
		expect(scrubRaw(['a@b.io'])).toEqual(['[redacted]']);
	});

	it('does not mutate its input and keeps plain map data intact', () => {
		const raw = {
			distance: 12.5,
			public: false,
			tags: ['a'],
			geometry: null,
			user_email: 'x@y.zz'
		};
		const copy = structuredClone(raw);
		const out = scrubRaw(raw);
		expect(raw).toEqual(copy);
		expect(out).toEqual({ distance: 12.5, public: false, tags: ['a'], geometry: null });
	});

	it('drops values JSON cannot carry', () => {
		expect(scrubRaw({ a: undefined, b: () => 1, c: 1 })).toEqual({ c: 1 });
	});
});

describe('isSensitiveKey', () => {
	it.each([
		'email',
		'Email',
		'user_email',
		'token',
		'csrfmiddlewaretoken',
		'Cookie',
		'phone_number'
	])('%s is sensitive', (key) => expect(isSensitiveKey(key)).toBe(true));
	it.each(['title', 'user_id', 'distance', 'geometry', 'public'])('%s is kept', (key) =>
		expect(isSensitiveKey(key)).toBe(false)
	);
});
