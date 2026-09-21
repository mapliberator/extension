/**
 * Fetch executor injected into the dedicated source tab with scripting.executeScript.
 *
 * Dumb by design (PRD §5.2): it checks that the URL is on the adapter's allowlisted origins,
 * performs the fetch with the page's own credentials, and returns the result. It holds no
 * cursors and no adapter logic, refuses non-GET methods, and never pushes.
 */
import { sourceHosts } from '../adapters/hosts';
import {
	BRIDGE_PORT_NAME,
	BridgeCommandSchema,
	FORWARDED_HEADERS,
	type BodyKind,
	type BridgeEvent
} from '../engine/bridge-protocol';

const CHUNK_CHARS = 64 * 1024;

declare global {
	// eslint-disable-next-line no-var
	var __mapliberatorExecutor: boolean | undefined;
}

export default defineUnlistedScript(() => {
	if (globalThis.__mapliberatorExecutor) return;
	globalThis.__mapliberatorExecutor = true;

	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== BRIDGE_PORT_NAME) return;
		if (port.sender?.id !== undefined && port.sender.id !== browser.runtime.id) return;
		serve(port);
	});
});

function serve(port: Browser.runtime.Port): void {
	let origins: string[] | null = null;
	const controllers = new Map<number, AbortController>();
	const acks = new Map<number, () => void>();

	const send = (event: BridgeEvent) => {
		try {
			port.postMessage(event);
		} catch {
			// Port closed: the export page will notice the disconnect.
		}
	};

	port.onDisconnect.addListener(() => {
		for (const controller of controllers.values()) controller.abort();
		for (const resolve of acks.values()) resolve();
	});

	port.onMessage.addListener((message: unknown) => {
		const parsed = BridgeCommandSchema.safeParse(message);
		if (!parsed.success) return;
		const command = parsed.data;
		switch (command.type) {
			case 'init': {
				const allowed = sourceHosts(import.meta.env.MODE)[command.adapter].origins;
				if (!allowed.includes(location.origin)) {
					send({ type: 'refused', reason: `executor is not on a ${command.adapter} origin` });
					return;
				}
				origins = allowed;
				send({ type: 'ready', origin: location.origin });
				return;
			}
			case 'ack':
				acks.get(command.id)?.();
				return;
			case 'abort':
				controllers.get(command.id)?.abort();
				return;
			case 'request':
				void execute(command);
				return;
		}
	});

	async function execute(command: {
		id: number;
		method: 'GET';
		url: string;
		accept: 'json' | 'text-stream';
		headers?: Record<string, string>;
	}): Promise<void> {
		const { id } = command;
		let url: URL;
		try {
			url = new URL(command.url);
		} catch {
			return send({ type: 'error', id, error: 'refused', message: 'invalid URL' });
		}
		if (!origins || !origins.includes(url.origin)) {
			return send({ type: 'error', id, error: 'refused', message: 'origin is not allowlisted' });
		}

		const controller = new AbortController();
		controllers.set(id, controller);
		try {
			const response = await fetch(url.href, {
				method: 'GET',
				credentials: 'include',
				redirect: 'follow',
				// The parking page's address says nothing about the request and is nobody's business.
				// (AllTrails also turns away any API call that names /robots.txt as its referrer.)
				referrerPolicy: 'no-referrer',
				signal: controller.signal,
				headers: {
					...command.headers,
					Accept: command.accept === 'json' ? 'application/json' : 'application/gpx+xml, */*'
				}
			});
			const headers: Record<string, string> = {};
			for (const name of FORWARDED_HEADERS) {
				const value = response.headers.get(name);
				if (value !== null) headers[name] = value;
			}
			const head = {
				id,
				status: response.status,
				headers,
				redirected: response.redirected,
				url: response.url
			};
			const contentType = (headers['content-type'] ?? '').toLowerCase();
			const looksHtml = contentType.includes('text/html');

			if (command.accept === 'text-stream' && response.status === 200 && !looksHtml) {
				send({ type: 'head', ...head });
				await streamText(id, response);
				send({ type: 'end', id });
				return;
			}

			const text = await response.text();
			let bodyKind: BodyKind = text.length === 0 ? 'empty' : looksHtml ? 'html' : 'text';
			let json: unknown;
			if (command.accept === 'json' && !looksHtml && text.length > 0) {
				try {
					json = JSON.parse(text);
					bodyKind = 'json';
				} catch {
					bodyKind = /^\s*</.test(text) ? 'html' : 'text';
				}
			}
			send({ type: 'response', ...head, bodyKind, ...(bodyKind === 'json' ? { json } : {}) });
		} catch (error) {
			send({
				type: 'error',
				id,
				error: controller.signal.aborted ? 'aborted' : 'network',
				message: error instanceof Error ? error.message : String(error)
			});
		} finally {
			controllers.delete(id);
			acks.delete(id);
		}
	}

	/** One chunk in flight: the next is sent only after the export page acknowledges the last. */
	async function streamText(id: number, response: Response): Promise<void> {
		if (!response.body) return;
		// ignoreBOM keeps a leading BOM in the text so native GPX stays byte-identical.
		const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
		const reader = response.body.getReader();
		const sendChunk = async (chunk: string) => {
			let at = 0;
			while (at < chunk.length) {
				let end = Math.min(at + CHUNK_CHARS, chunk.length);
				// Never split a surrogate pair: each chunk is UTF-8 encoded on its own downstream.
				const last = chunk.charCodeAt(end - 1);
				if (end < chunk.length && last >= 0xd800 && last <= 0xdbff) end--;
				const acked = new Promise<void>((resolve) => acks.set(id, resolve));
				send({ type: 'chunk', id, chunk: chunk.slice(at, end) });
				await acked;
				at = end;
			}
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			if (text) await sendChunk(text);
		}
		const tail = decoder.decode();
		if (tail) await sendChunk(tail);
	}
}
