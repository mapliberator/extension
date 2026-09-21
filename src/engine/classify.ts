/**
 * Turns one bridged attempt into a pacing outcome (PRD §6.3, §7). Details never contain names,
 * IDs or URLs so they can go straight into the diagnostic report.
 */
import { ItemError } from '../shared/errors';
import {
	BridgeNetworkError,
	BridgeRefusedError,
	TabLostError,
	type BridgeResponse
} from './bridge-types';
import { parseRetryAfter, type AttemptOutcome } from './pacing';

export interface ClassifyContext {
	isLoginUrl(url: string): boolean;
	isSignedOut?(response: { status: number; bodyKind: string; json?: unknown }): boolean;
}

export function classifyTransportError(error: unknown): AttemptOutcome<never> {
	if (error instanceof TabLostError) return { type: 'tab-lost' };
	if (error instanceof BridgeNetworkError) {
		return { type: 'retry', reason: 'network', detail: 'network error' };
	}
	if (error instanceof BridgeRefusedError) {
		return { type: 'fail', error: new ItemError('refused', error.message) };
	}
	throw error;
}

function isChallengeJson(json: unknown): boolean {
	if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
	const keys = Object.keys(json);
	return keys.length === 1 && typeof (json as { url?: unknown }).url === 'string';
}

function isLoginRedirect(response: BridgeResponse, context: ClassifyContext): boolean {
	return (
		(response.redirected && context.isLoginUrl(response.url)) ||
		context.isSignedOut?.(response) === true
	);
}

/** JSON API responses. */
export function classifyJsonResponse(
	response: BridgeResponse,
	context: ClassifyContext
): AttemptOutcome<unknown> {
	const { status } = response;
	if (status === 401 || isLoginRedirect(response, context))
		return { type: 'pause', reason: 'auth' };
	// A bot-protection challenge delivered as JSON: `{ "url": "<captcha page>" }` and nothing else.
	if (status === 403 && isChallengeJson(response.json))
		return { type: 'pause', reason: 'challenge' };
	if (status === 429 || (status === 403 && response.bodyKind !== 'html')) {
		return {
			type: 'retry',
			reason: 'rate-limited',
			detail: `HTTP ${status}`,
			retryAfterMs: parseRetryAfter(response.headers['retry-after'])
		};
	}
	// HTML where JSON was expected: a challenge or interstitial page.
	if (response.bodyKind === 'html' && (status === 200 || status === 403)) {
		return { type: 'pause', reason: 'challenge' };
	}
	if (status >= 500) {
		return {
			type: 'retry',
			reason: 'server',
			detail: `HTTP ${status}`,
			retryAfterMs: parseRetryAfter(response.headers['retry-after'])
		};
	}
	if (status >= 200 && status < 300) {
		if (response.bodyKind !== 'json') {
			return { type: 'fail', error: new ItemError('invalid-json', 'response was not JSON') };
		}
		return { type: 'ok', value: response.json };
	}
	return { type: 'fail', error: new ItemError(`http-${status}`, `HTTP ${status}`) };
}

export type NativeGpxResult = { native: true } | { native: false; reason: string };

/**
 * Native GPX responses. Anything that is not a clean 200 stream makes the engine fall back to the
 * JSON API for that one object — except a lost session, which pauses like everywhere else.
 */
export function classifyGpxResponse(
	response: BridgeResponse,
	context: ClassifyContext
): AttemptOutcome<NativeGpxResult> {
	const { status } = response;
	if (status === 401 || isLoginRedirect(response, context))
		return { type: 'pause', reason: 'auth' };
	if (status === 200 && response.bodyKind === 'stream')
		return { type: 'ok', value: { native: true } };
	if (status === 429) {
		return {
			type: 'retry',
			reason: 'rate-limited',
			detail: 'HTTP 429',
			retryAfterMs: parseRetryAfter(response.headers['retry-after']),
			onExhausted: 'fail'
		};
	}
	if (status >= 500) return { type: 'retry', reason: 'server', detail: `HTTP ${status}` };
	const reason = status === 200 ? `unexpected ${response.bodyKind} body` : `HTTP ${status}`;
	return { type: 'ok', value: { native: false, reason } };
}
