/**
 * Port protocol between the export page and the executor injected into the dedicated source tab
 * (PRD §5.2). Everything the tab sends is validated with zod on the export-page side.
 */
import { z } from 'zod';
import { SourceIdSchema } from '../shared/messages';

export const BRIDGE_PORT_NAME = 'mapliberator-bridge';

export const BridgeCommandSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('init'), adapter: SourceIdSchema }),
	z.object({
		type: z.literal('request'),
		id: z.number().int(),
		method: z.literal('GET'),
		url: z.string(),
		accept: z.enum(['json', 'text-stream'])
	}),
	z.object({ type: z.literal('ack'), id: z.number().int() }),
	z.object({ type: z.literal('abort'), id: z.number().int() })
]);
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;

const HeadersSchema = z.record(z.string(), z.string());
const BodyKindSchema = z.enum(['json', 'html', 'text', 'empty']);
export type BodyKind = z.infer<typeof BodyKindSchema>;

const head = {
	id: z.number().int(),
	status: z.number().int(),
	headers: HeadersSchema,
	redirected: z.boolean(),
	/** Final URL after redirects. */
	url: z.string()
};

export const BridgeEventSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready'), origin: z.string() }),
	z.object({ type: z.literal('refused'), reason: z.string() }),
	/** Complete response: JSON requests, and streams that did not start (non-200 or HTML). */
	z.object({
		type: z.literal('response'),
		...head,
		bodyKind: BodyKindSchema,
		json: z.unknown().optional()
	}),
	/** A text stream is starting; chunks follow, each acknowledged before the next is sent. */
	z.object({ type: z.literal('head'), ...head }),
	z.object({ type: z.literal('chunk'), id: z.number().int(), chunk: z.string() }),
	z.object({ type: z.literal('end'), id: z.number().int() }),
	z.object({
		type: z.literal('error'),
		id: z.number().int(),
		error: z.enum(['network', 'refused', 'aborted']),
		message: z.string()
	})
]);
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

/** Response headers the engine needs. Nothing else crosses the bridge — never Set-Cookie. */
export const FORWARDED_HEADERS = ['content-type', 'retry-after', 'content-length'];
