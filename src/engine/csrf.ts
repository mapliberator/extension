/**
 * CSRF tokens, minted by the engine and added to the requests that ask for one. Adapters only
 * say where a token comes from (`CsrfSource`); the token itself never reaches them.
 *
 * Every bridged request of a run goes through `send`, so JSON calls and native GPX exports get
 * a token the same way. A token with `lifetime: 'attempt'` is minted inside the attempt and
 * forgotten after it. One with `lifetime: 'session'` is kept, and dropped as soon as a response
 * says the session or the token is no good: the next request mints a fresh one, so a token never
 * outlives the session it was minted for.
 */
import { ItemError } from '../shared/errors';
import type { BridgeRequest, CsrfSource } from '../shared/models';
import type { BridgeResponse } from './bridge-types';
import { classifyJsonResponse, isLoginRedirect, type ClassifyContext } from './classify';
import { parseRetryAfter, type AttemptOutcome } from './pacing';
import type { BridgeRequester } from './transport';

export type SendResult =
	| { type: 'response'; response: BridgeResponse }
	/** No token could be had: the attempt ends with this outcome, and nothing was sent. */
	| { type: 'outcome'; outcome: AttemptOutcome<never> };

/** Sends bridged requests, adding the CSRF token a request's `csrf` asks for. */
export interface SourceRequester {
	/**
	 * One attempt's worth of requests: the token (when one is needed and not held) and then the
	 * request. `paced` is awaited before every request after the first, so the lane's floor holds
	 * between them.
	 */
	send(
		request: BridgeRequest,
		paced: () => Promise<void>,
		onChunk?: (chunk: string) => Promise<void>
	): Promise<SendResult>;
}

export function createSourceRequester(
	bridge: BridgeRequester,
	context: () => ClassifyContext
): SourceRequester {
	/** Session-lifetime tokens, by mint URL. */
	const held = new Map<string, string>();

	async function mint(source: CsrfSource): Promise<AttemptOutcome<string>> {
		const { mint } = source;
		if (mint.method === 'POST') {
			const minted = classifyJsonResponse(
				await bridge.request({ method: 'POST', url: mint.url, accept: 'json' }),
				context()
			);
			if (minted.type !== 'ok') return minted;
			const token =
				typeof minted.value === 'object' && minted.value !== null
					? (minted.value as Record<string, unknown>)[mint.field]
					: undefined;
			return typeof token === 'string' && token !== '' ? { type: 'ok', value: token } : noToken();
		}
		const page = classifyTokenPage(
			await bridge.request({ method: 'GET', url: mint.url, accept: 'text' }),
			context()
		);
		if (page.type !== 'ok') return page;
		const token = readMeta(page.value, mint.meta);
		return token ? { type: 'ok', value: token } : noToken();
	}

	return {
		async send(request, paced, onChunk) {
			const { csrf, ...plain } = request;
			if (!csrf) return { type: 'response', response: await bridge.request(plain, onChunk) };

			const key = csrf.mint.url;
			const reuse = csrf.lifetime === 'session';
			let sent = 0;
			const next = async () => {
				if (sent++ > 0) await paced();
			};
			for (let reminted = false; ; reminted = true) {
				let token = reuse ? held.get(key) : undefined;
				const fresh = token === undefined;
				if (token === undefined) {
					await next();
					const minted = await mint(csrf);
					if (minted.type !== 'ok') return { type: 'outcome', outcome: minted };
					token = minted.value;
					if (reuse) held.set(key, token);
				}
				await next();
				const response = await bridge.request(
					{ ...plain, headers: { ...plain.headers, [csrf.header]: token } },
					onChunk
				);
				if (!refused(response, context())) return { type: 'response', response };
				if (held.get(key) === token) held.delete(key);
				// A held token the platform no longer takes: mint once more, inside this attempt.
				// A fresh one refused is the platform's answer, and is classified as such.
				if (fresh || reminted || response.status !== 403) {
					return { type: 'response', response };
				}
			}
		}
	};
}

/** The session is gone, or the token was turned down. */
function refused(response: BridgeResponse, context: ClassifyContext): boolean {
	return response.status === 401 || response.status === 403 || isLoginRedirect(response, context);
}

function noToken(): AttemptOutcome<never> {
	return { type: 'fail', error: new ItemError('csrf', 'no CSRF token in the response') };
}

/**
 * The page a token is read from. HTML is what is expected here; a sign-in page (redirected to,
 * or a 401) pauses for the user, and a 403 is read as on any API call: a challenge page pauses,
 * anything else is rate limiting.
 */
function classifyTokenPage(
	response: BridgeResponse,
	context: ClassifyContext
): AttemptOutcome<string> {
	const { status } = response;
	if (status === 401 || isLoginRedirect(response, context))
		return { type: 'pause', reason: 'auth' };
	const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
	if (status === 403 && response.bodyKind === 'html') return { type: 'pause', reason: 'challenge' };
	if (status === 429 || status === 403) {
		return { type: 'retry', reason: 'rate-limited', detail: `HTTP ${status}`, retryAfterMs };
	}
	if (status >= 500) {
		return { type: 'retry', reason: 'server', detail: `HTTP ${status}`, retryAfterMs };
	}
	if (status >= 200 && status < 300) return { type: 'ok', value: response.text ?? '' };
	return { type: 'fail', error: new ItemError(`http-${status}`, `HTTP ${status}`) };
}

/** `content` of the first `<meta name="…">`, attributes in any order and either quote. */
export function readMeta(html: string, name: string): string | null {
	for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
		if (attribute(tag, 'name') !== name) continue;
		const content = attribute(tag, 'content');
		return content ? content : null;
	}
	return null;
}

function attribute(tag: string, name: string): string | null {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
	return match ? (match[1] ?? match[2] ?? null) : null;
}
