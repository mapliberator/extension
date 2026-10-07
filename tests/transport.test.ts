import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResponse } from '../src/engine/bridge-types.ts';
import { Lane } from '../src/engine/pacing.ts';
import { RunController } from '../src/engine/state.ts';
import { PRODUCTION_TIMINGS } from '../src/engine/timings.ts';
import { createSourceRequester, readMeta } from '../src/engine/csrf.ts';
import { createAdapterTransport, fetchNativeGpx } from '../src/engine/transport.ts';
import { ItemError } from '../src/shared/errors.ts';
import type { BridgeRequest, CsrfSource } from '../src/shared/models.ts';

beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
afterEach(() => vi.useRealTimers());

const MINT = 'https://site.test/mint';
const CSRF: CsrfSource = {
	mint: { method: 'POST', url: MINT, field: 'token' },
	header: 'x-csrf-token',
	lifetime: 'attempt'
};
const PAGE = 'https://site.test/app/';
const SESSION_CSRF: CsrfSource = {
	mint: { method: 'GET', url: PAGE, meta: 'csrf-token' },
	header: 'connect-csrf-token',
	lifetime: 'session'
};
const QUERY = 'https://site.test/query';

function page(token: string | null, status = 200): BridgeResponse {
	const head = token === null ? '' : `<meta name="csrf-token" content="${token}"/>`;
	return {
		status,
		headers: { 'content-type': 'text/html' },
		redirected: false,
		url: PAGE,
		bodyKind: 'html',
		text: `<!DOCTYPE html><html><head><meta charset="utf-8"/>${head}</head><body></body></html>`
	};
}

function json(status: number, body?: unknown): BridgeResponse {
	return {
		status,
		headers: {},
		redirected: false,
		url: QUERY,
		bodyKind: body === undefined ? 'empty' : 'json',
		...(body === undefined ? {} : { json: body })
	};
}

/** A bridge whose answers are scripted per request; it records what it was asked and when. */
function setup(
	answer: (request: BridgeRequest, index: number) => BridgeResponse,
	{ signedOutOn403 = true } = {}
) {
	const controller = new RunController();
	controller.start();
	const lane = new Lane(controller, { concurrency: 1, minIntervalMs: 500 }, PRODUCTION_TIMINGS, {
		random: () => 0.5
	});
	const sent: (BridgeRequest & { at: number })[] = [];
	const bridge = {
		async request(request: BridgeRequest) {
			sent.push({ ...request, at: Date.now() });
			return answer(request, sent.length - 1);
		}
	};
	const context = () => ({
		isLoginUrl: (url: string) => url.endsWith('/signin/'),
		isSignedOut: (response: { status: number; bodyKind: string }) =>
			signedOutOn403 && response.status === 403 && response.bodyKind === 'empty'
	});
	const requester = createSourceRequester(bridge, context);
	const transport = createAdapterTransport(requester, (attempt) => lane.run(attempt), context);
	return { controller, lane, requester, sent, transport, context };
}

describe('postJson', () => {
	it('mints a token, waits out the pacing floor, then POSTs the JSON body with it', async () => {
		const { sent, transport } = setup((request) =>
			request.url === MINT ? json(200, { token: 't-1' }) : json(200, { ok: true })
		);
		const result = transport.postJson(QUERY, { after: '0' }, { headers: { X: 'y' }, csrf: CSRF });
		await vi.runAllTimersAsync();
		expect(await result).toEqual({ ok: true });
		expect(sent.map(({ at: _at, ...request }) => request)).toEqual([
			{ method: 'POST', url: MINT, accept: 'json' },
			{
				method: 'POST',
				url: QUERY,
				accept: 'json',
				headers: { X: 'y', 'x-csrf-token': 't-1' },
				body: '{"after":"0"}'
			}
		]);
		// floor 500 + jitter(30..100) at random 0.5
		expect(sent[1]!.at - sent[0]!.at).toBe(565);
	});

	it('a retry after signing in again mints a token for the new session', async () => {
		let session = 1;
		const { controller, sent, transport } = setup((request) => {
			if (request.url === MINT) return json(200, { token: `t-${session}` });
			// Only the current session's token is accepted; anything else is a bare 403.
			return request.headers?.['x-csrf-token'] === `t-2` ? json(200, { ok: true }) : json(403);
		});
		const result = transport.postJson(QUERY, {}, { csrf: CSRF });
		await vi.advanceTimersByTimeAsync(2000);
		expect(controller.pause?.reason).toBe('auth');
		session = 2;
		controller.resume();
		await vi.runAllTimersAsync();
		expect(await result).toEqual({ ok: true });
		expect(sent.map((request) => request.headers?.['x-csrf-token'] ?? 'mint')).toEqual([
			'mint',
			't-1',
			'mint',
			't-2'
		]);
	});

	it('an answer without a token fails the request instead of sending an empty header', async () => {
		const { sent, transport } = setup(() => json(200, { nothing: true }));
		const result = transport.postJson(QUERY, {}, { csrf: CSRF }).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await result;
		expect(error).toBeInstanceOf(ItemError);
		expect((error as ItemError).category).toBe('csrf');
		expect(sent).toHaveLength(1);
	});

	it('without csrf it is a single paced POST', async () => {
		const { sent, transport } = setup(() => json(200, [1]));
		const result = transport.postJson(QUERY, { a: 1 });
		await vi.runAllTimersAsync();
		expect(await result).toEqual([1]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ method: 'POST', body: '{"a":1}', headers: {} });
	});
});

describe('session-lifetime tokens read from a page', () => {
	/** A site that hands out `t-<session>` on its app page and accepts nothing else. */
	function site(state: { session: number; signedIn: boolean }) {
		return (request: BridgeRequest): BridgeResponse => {
			if (request.url === PAGE) {
				if (!state.signedIn) {
					return { ...page(null), redirected: true, url: 'https://site.test/signin/' };
				}
				return page(`t-${state.session}`);
			}
			if (!state.signedIn) return json(401);
			const token = request.headers?.['connect-csrf-token'];
			return token === `t-${state.session}` ? json(200, { ok: request.url }) : json(403);
		};
	}
	const tokens = (sent: BridgeRequest[]) =>
		sent.map((request) =>
			request.url === PAGE ? 'page' : (request.headers?.['connect-csrf-token'] ?? 'none')
		);

	it('reads the token once, from a GET of the page, and sends it with every request', async () => {
		const state = { session: 1, signedIn: true };
		const { sent, transport } = setup(site(state), { signedOutOn403: false });
		const results = Promise.all([
			transport.getJson(`${QUERY}/a`, { csrf: SESSION_CSRF }),
			transport.getJson(`${QUERY}/b`, { headers: { X: 'y' }, csrf: SESSION_CSRF })
		]);
		await vi.runAllTimersAsync();
		expect(await results).toEqual([{ ok: `${QUERY}/a` }, { ok: `${QUERY}/b` }]);
		expect(sent.map(({ at: _at, ...request }) => request)).toEqual([
			{ method: 'GET', url: PAGE, accept: 'text' },
			{
				method: 'GET',
				url: `${QUERY}/a`,
				accept: 'json',
				headers: { 'connect-csrf-token': 't-1' }
			},
			{
				method: 'GET',
				url: `${QUERY}/b`,
				accept: 'json',
				headers: { X: 'y', 'connect-csrf-token': 't-1' }
			}
		]);
		// The page and the request after it are paced like any two requests.
		expect(sent[1]!.at - sent[0]!.at).toBe(565);
	});

	it('a refused token is read again, once, inside the same attempt', async () => {
		const state = { session: 1, signedIn: true };
		const { sent, transport } = setup(site(state), { signedOutOn403: false });
		const first = transport.getJson(QUERY, { csrf: SESSION_CSRF });
		await vi.runAllTimersAsync();
		await first;
		// The platform rotates the token without the session ending.
		state.session = 2;
		const second = transport.getJson(QUERY, { csrf: SESSION_CSRF });
		await vi.runAllTimersAsync();
		expect(await second).toEqual({ ok: QUERY });
		expect(tokens(sent)).toEqual(['page', 't-1', 't-1', 'page', 't-2']);
	});

	it('a lost session drops the token: after signing in again, a fresh one is read', async () => {
		const state = { session: 1, signedIn: true };
		const { controller, sent, transport } = setup(site(state), { signedOutOn403: false });
		const first = transport.getJson(QUERY, { csrf: SESSION_CSRF });
		await vi.runAllTimersAsync();
		await first;
		state.signedIn = false;
		const second = transport.getJson(QUERY, { csrf: SESSION_CSRF });
		await vi.advanceTimersByTimeAsync(2000);
		expect(controller.pause?.reason).toBe('auth');
		state.signedIn = true;
		state.session = 2;
		controller.resume();
		await vi.runAllTimersAsync();
		expect(await second).toEqual({ ok: QUERY });
		expect(tokens(sent)).toEqual(['page', 't-1', 't-1', 'page', 't-2']);
	});

	it('a token page that sends the user to sign in pauses the run for it', async () => {
		const state = { session: 1, signedIn: false };
		const { controller, sent, transport } = setup(site(state), { signedOutOn403: false });
		const result = transport.getJson(QUERY, { csrf: SESSION_CSRF });
		await vi.advanceTimersByTimeAsync(2000);
		expect(controller.pause?.reason).toBe('auth');
		state.signedIn = true;
		controller.resume();
		await vi.runAllTimersAsync();
		expect(await result).toEqual({ ok: QUERY });
		expect(tokens(sent)).toEqual(['page', 'page', 't-1']);
	});

	it('a challenge page where the token page should be pauses the run, as on any API call', async () => {
		let challenged = true;
		const { controller, sent, transport } = setup(
			(request) =>
				request.url !== PAGE ? json(200, { ok: true }) : challenged ? page(null, 403) : page('t-1'),
			{ signedOutOn403: false }
		);
		const result = transport.getJson(QUERY, { csrf: SESSION_CSRF });
		await vi.advanceTimersByTimeAsync(2000);
		expect(controller.pause?.reason).toBe('challenge');
		challenged = false;
		await vi.runAllTimersAsync();
		expect(await result).toEqual({ ok: true });
		expect(sent.map((request) => request.url)).toEqual([PAGE, PAGE, QUERY]);
	});

	it('a page without the token fails the request instead of sending an empty header', async () => {
		const { sent, transport } = setup(() => page(null), { signedOutOn403: false });
		const result = transport
			.getJson(QUERY, { csrf: SESSION_CSRF })
			.catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await result;
		expect(error).toBeInstanceOf(ItemError);
		expect((error as ItemError).category).toBe('csrf');
		expect(sent).toHaveLength(1);
	});

	it('native GPX exports carry the held token; the csrf field never crosses the bridge', async () => {
		const { lane, requester, sent, context } = setup(
			(request) =>
				request.url === PAGE
					? page('t-1')
					: {
							status: 200,
							headers: {},
							redirected: false,
							url: request.url,
							bodyKind: 'stream'
						},
			{ signedOutOn403: false }
		);
		const result = fetchNativeGpx({
			requester,
			lane,
			context: context(),
			request: { method: 'GET', url: `${QUERY}.gpx`, accept: 'text-stream', csrf: SESSION_CSRF },
			begin: async () => {},
			onChunk: async () => {}
		});
		await vi.runAllTimersAsync();
		expect(await result).toEqual({ native: true });
		expect(sent.map(({ at: _at, ...request }) => request)).toEqual([
			{ method: 'GET', url: PAGE, accept: 'text' },
			{
				method: 'GET',
				url: `${QUERY}.gpx`,
				accept: 'text-stream',
				headers: { 'connect-csrf-token': 't-1' }
			}
		]);
	});
});

describe('readMeta', () => {
	it('finds the content of a named meta tag, whatever the attribute order or quotes', () => {
		expect(readMeta('<meta name="csrf-token" content="abc"/>', 'csrf-token')).toBe('abc');
		expect(readMeta("<META content='abc' NAME='csrf-token'>", 'csrf-token')).toBe('abc');
		expect(
			readMeta(
				'<meta name="viewport" content="x"><meta name="csrf-token" content="y">',
				'csrf-token'
			)
		).toBe('y');
		expect(readMeta('<meta name="csrf-token-other" content="x">', 'csrf-token')).toBeNull();
		expect(readMeta('<meta name="csrf-token" content="">', 'csrf-token')).toBeNull();
		expect(readMeta('no tags here', 'csrf-token')).toBeNull();
	});
});
