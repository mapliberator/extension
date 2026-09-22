import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResponse } from '../src/engine/bridge-types.ts';
import { Lane } from '../src/engine/pacing.ts';
import { RunController } from '../src/engine/state.ts';
import { PRODUCTION_TIMINGS } from '../src/engine/timings.ts';
import { createAdapterTransport } from '../src/engine/transport.ts';
import { ItemError } from '../src/shared/errors.ts';
import type { BridgeRequest, CsrfSource } from '../src/shared/models.ts';

beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));
afterEach(() => vi.useRealTimers());

const CSRF: CsrfSource = { url: 'https://site.test/mint', field: 'token', header: 'x-csrf-token' };
const QUERY = 'https://site.test/query';

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
function setup(answer: (request: BridgeRequest, index: number) => BridgeResponse) {
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
	const transport = createAdapterTransport(
		bridge,
		(attempt) => lane.run(attempt),
		() => ({
			isLoginUrl: () => false,
			isSignedOut: (response) => response.status === 403 && response.bodyKind === 'empty'
		})
	);
	return { controller, sent, transport };
}

describe('postJson', () => {
	it('mints a token, waits out the pacing floor, then POSTs the JSON body with it', async () => {
		const { sent, transport } = setup((request) =>
			request.url === CSRF.url ? json(200, { token: 't-1' }) : json(200, { ok: true })
		);
		const result = transport.postJson(QUERY, { after: '0' }, { headers: { X: 'y' }, csrf: CSRF });
		await vi.runAllTimersAsync();
		expect(await result).toEqual({ ok: true });
		expect(sent.map(({ at: _at, ...request }) => request)).toEqual([
			{ method: 'POST', url: CSRF.url, accept: 'json' },
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
			if (request.url === CSRF.url) return json(200, { token: `t-${session}` });
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
