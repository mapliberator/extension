/** Wires the bridge into pacing lanes: the AdapterTransport adapters see, plus native GPX. */
import { ItemError } from '../shared/errors';
import type { AdapterTransport, BridgeRequest } from '../shared/models';
import type { BridgeResponse } from './bridge-types';
import {
	classifyGpxResponse,
	classifyJsonResponse,
	classifyTransportError,
	type ClassifyContext,
	type NativeGpxResult
} from './classify';
import type { Lane } from './pacing';
import { GpxRejectedError } from './worker-client';

/** The lane is built from the adapter's limits, and the adapter needs a transport first. */
export type LaneRunner = Lane['run'];

/** All the transport needs of the SourceBridge. */
export interface BridgeRequester {
	request(
		request: BridgeRequest,
		onChunk?: (chunk: string) => Promise<void>
	): Promise<BridgeResponse>;
}

export function createAdapterTransport(
	bridge: BridgeRequester,
	run: LaneRunner,
	context: () => ClassifyContext
): AdapterTransport {
	return {
		getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
			return run(async () => {
				try {
					const response = await bridge.request({
						method: 'GET',
						url,
						accept: 'json',
						...(headers ? { headers } : {})
					});
					return classifyJsonResponse(response, context());
				} catch (error) {
					return classifyTransportError(error);
				}
			});
		},

		postJson(url, body, options = {}): Promise<unknown> {
			const { csrf } = options;
			return run(async (paced) => {
				try {
					const headers = { ...options.headers };
					if (csrf) {
						// Minted inside the attempt: a retry after a re-login gets a token for the new
						// session, and the token dies with the attempt.
						const minted = classifyJsonResponse(
							await bridge.request({ method: 'POST', url: csrf.url, accept: 'json' }),
							context()
						);
						if (minted.type !== 'ok') return minted;
						const token =
							typeof minted.value === 'object' && minted.value !== null
								? (minted.value as Record<string, unknown>)[csrf.field]
								: undefined;
						if (typeof token !== 'string' || token === '') {
							return {
								type: 'fail',
								error: new ItemError('csrf', 'no CSRF token in the response')
							};
						}
						headers[csrf.header] = token;
						await paced();
					}
					const response = await bridge.request({
						method: 'POST',
						url,
						accept: 'json',
						headers,
						body: JSON.stringify(body)
					});
					return classifyJsonResponse(response, context());
				} catch (error) {
					return classifyTransportError(error);
				}
			});
		}
	};
}

/**
 * Stream a platform's native GPX through `onChunk`. Resolves `{ native: false }` whenever the
 * engine should fall back to the JSON API for this object.
 */
export function fetchNativeGpx(args: {
	bridge: BridgeRequester;
	lane: Lane;
	context: ClassifyContext;
	request: BridgeRequest;
	/** Called before every attempt so partial data from a failed attempt is dropped. */
	begin(): Promise<void>;
	onChunk(chunk: string): Promise<void>;
}): Promise<NativeGpxResult> {
	const { bridge, lane, context, request } = args;
	return lane.run<NativeGpxResult>(async () => {
		try {
			await args.begin();
			const response = await bridge.request(request, args.onChunk);
			return classifyGpxResponse(response, context);
		} catch (error) {
			if (error instanceof GpxRejectedError) {
				return { type: 'ok', value: { native: false, reason: error.message } };
			}
			return classifyTransportError(error);
		}
	});
}
