/** Wires the bridge into pacing lanes: the AdapterTransport adapters see, plus native GPX. */
import type { AdapterTransport, BridgeRequest } from '../shared/models';
import type { BridgeResponse } from './bridge-types';
import {
	classifyGpxResponse,
	classifyJsonResponse,
	classifyTransportError,
	type ClassifyContext,
	type NativeGpxResult
} from './classify';
import type { SourceRequester } from './csrf';
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
	requester: SourceRequester,
	run: LaneRunner,
	context: () => ClassifyContext
): AdapterTransport {
	const json = (request: BridgeRequest): Promise<unknown> =>
		run(async (paced) => {
			try {
				const sent = await requester.send(request, paced);
				if (sent.type === 'outcome') return sent.outcome;
				return classifyJsonResponse(sent.response, context());
			} catch (error) {
				return classifyTransportError(error);
			}
		});

	return {
		getJson(url, { headers, csrf } = {}) {
			return json({
				method: 'GET',
				url,
				accept: 'json',
				...(headers ? { headers } : {}),
				...(csrf ? { csrf } : {})
			});
		},

		postJson(url, body, { headers, csrf } = {}) {
			return json({
				method: 'POST',
				url,
				accept: 'json',
				headers: { ...headers },
				body: JSON.stringify(body),
				...(csrf ? { csrf } : {})
			});
		}
	};
}

/**
 * Stream a platform's native GPX through `onChunk`. Resolves `{ native: false }` whenever the
 * engine should fall back to the JSON API for this object.
 */
export function fetchNativeGpx(args: {
	requester: SourceRequester;
	lane: Lane;
	context: ClassifyContext;
	request: BridgeRequest;
	/** Called before every attempt so partial data from a failed attempt is dropped. */
	begin(): Promise<void>;
	onChunk(chunk: string): Promise<void>;
}): Promise<NativeGpxResult> {
	const { requester, lane, context, request } = args;
	return lane.run<NativeGpxResult>(async (paced) => {
		try {
			await args.begin();
			const sent = await requester.send(request, paced, args.onChunk);
			if (sent.type === 'outcome') return sent.outcome;
			return classifyGpxResponse(sent.response, context);
		} catch (error) {
			if (error instanceof GpxRejectedError) {
				return { type: 'ok', value: { native: false, reason: error.message } };
			}
			return classifyTransportError(error);
		}
	});
}
