/** Wires the bridge into pacing lanes: the AdapterTransport adapters see, plus native GPX. */
import type { AdapterTransport, BridgeRequest } from '../shared/models';
import type { SourceBridge } from './bridge';
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

export function createAdapterTransport(
	bridge: SourceBridge,
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
		}
	};
}

/**
 * Stream a platform's native GPX through `onChunk`. Resolves `{ native: false }` whenever the
 * engine should fall back to the JSON API for this object.
 */
export function fetchNativeGpx(args: {
	bridge: SourceBridge;
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
