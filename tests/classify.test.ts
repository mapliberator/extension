import { describe, expect, it } from 'vitest';
import type { BridgeResponse } from '../src/engine/bridge-types.ts';
import { classifyJsonResponse } from '../src/engine/classify.ts';

const context = { isLoginUrl: (url: string) => new URL(url).pathname.startsWith('/login') };
const response = (partial: Partial<BridgeResponse>): BridgeResponse => ({
	status: 200,
	headers: {},
	redirected: false,
	url: 'https://example.test/api/thing',
	bodyKind: 'json',
	...partial
});

describe('classifyJsonResponse', () => {
	it('a bot challenge delivered as JSON pauses for the user instead of counting as rate limiting', () => {
		const challenge = response({ status: 403, json: { url: 'https://captcha.example/abc' } });
		expect(classifyJsonResponse(challenge, context)).toEqual({
			type: 'pause',
			reason: 'challenge'
		});
	});

	it('any other 403 JSON is still treated as rate limiting', () => {
		for (const json of [{ error: 'forbidden' }, { url: 'x', more: 1 }, ['url'], null]) {
			expect(classifyJsonResponse(response({ status: 403, json }), context)).toMatchObject({
				type: 'retry',
				reason: 'rate-limited'
			});
		}
	});

	it('401, a redirect to sign-in and an adapter’s own signed-out answer all pause for sign-in', () => {
		const auth = { type: 'pause', reason: 'auth' };
		expect(classifyJsonResponse(response({ status: 401 }), context)).toEqual(auth);
		expect(
			classifyJsonResponse(
				response({ redirected: true, url: 'https://example.test/login', bodyKind: 'html' }),
				context
			)
		).toEqual(auth);
		const gaiaLike = {
			...context,
			isSignedOut: (r: { status: number; bodyKind: string }) =>
				r.status === 403 && r.bodyKind === 'empty'
		};
		expect(classifyJsonResponse(response({ status: 403, bodyKind: 'empty' }), gaiaLike)).toEqual(
			auth
		);
	});

	it('HTML where JSON was expected is a verification page; clean JSON passes through', () => {
		expect(classifyJsonResponse(response({ bodyKind: 'html' }), context)).toEqual({
			type: 'pause',
			reason: 'challenge'
		});
		expect(classifyJsonResponse(response({ json: { ok: true } }), context)).toEqual({
			type: 'ok',
			value: { ok: true }
		});
	});
});
