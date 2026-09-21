/** HTTP server: Host routing, sessions, fault injection, request log. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
	buildAllTrails,
	allTrailsPhotoRedirect,
	handleAllTrailsApi,
	handleAllTrailsCdn,
	trailBySlug,
	type AllTrailsData
} from './alltrails.ts';
import { resolveDataset, type Env, type ResolvedDataset } from './dataset.ts';
import {
	GAIA_ANONYMOUS_USER,
	buildGaia,
	gaiaPhotoRedirect,
	handleGaiaApi,
	handleGaiaCdn,
	type GaiaData
} from './gaia.ts';
import { xmlEscape } from './gpx.ts';
import { streamPhoto } from './photos.ts';
import type { Reply } from './reply.ts';
import { SENTINELS } from './sentinels.ts';
import type {
	AllTrailsObjects,
	Fault,
	FakeSource,
	GaiaObjects,
	Lane,
	Platform,
	RequestLogEntry,
	SourceStats,
	StartOptions
} from './types.ts';

const COOKIE_NAME = 'fs_session';
const SITE_HOST: Record<Platform, 'gaia.localhost' | 'alltrails.localhost'> = {
	gaiagps: 'gaia.localhost',
	alltrails: 'alltrails.localhost'
};
const PLATFORM_LABEL: Record<Platform, string> = {
	gaiagps: 'Fake Gaia',
	alltrails: 'Fake AllTrails'
};
const PLATFORMS: Platform[] = ['gaiagps', 'alltrails'];

interface LiveEntry extends RequestLogEntry {
	open: boolean;
}

interface FaultState {
	fault: Fault;
	regex: RegExp;
	seen: number;
}

function isPlatform(value: unknown): value is Platform {
	return value === 'gaiagps' || value === 'alltrails';
}

function routeHost(hostHeader: string | undefined): { platform: Platform; cdn: boolean } | null {
	const host = (hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
	switch (host) {
		case 'gaia.localhost':
			return { platform: 'gaiagps', cdn: false };
		case 'cdn.gaia.localhost':
			return { platform: 'gaiagps', cdn: true };
		case 'alltrails.localhost':
			return { platform: 'alltrails', cdn: false };
		case 'cdn.alltrails.localhost':
			return { platform: 'alltrails', cdn: true };
		default:
			return null;
	}
}

function readCookie(header: string | undefined, name: string): string | undefined {
	for (const part of (header ?? '').split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
		req.on('close', () => reject(new Error('aborted')));
	});
}

function computeStats(entries: LiveEntry[], platform: Platform): SourceStats {
	const peak = (lane: Lane): number => {
		const events: [time: number, delta: number][] = [];
		for (const e of entries) {
			if (e.platform !== platform || e.lane !== lane) continue;
			events.push([e.start, 1]);
			if (!e.open) events.push([e.end, -1]);
		}
		// At equal times a finished request leaves before the next one enters.
		events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		let current = 0;
		let max = 0;
		for (const [, delta] of events) {
			current += delta;
			if (current > max) max = current;
		}
		return max;
	};
	const api = entries.filter((e) => e.platform === platform && e.lane === 'api');
	const starts = api.map((e) => e.start).sort((a, b) => a - b);
	let minGap = Infinity;
	for (let i = 1; i < starts.length; i++) minGap = Math.min(minGap, starts[i]! - starts[i - 1]!);
	return {
		apiRequests: api.length,
		assetRequests: entries.filter((e) => e.platform === platform && e.lane === 'asset').length,
		peakApiConcurrency: peak('api'),
		peakAssetConcurrency: peak('asset'),
		minApiGapMs: minGap
	};
}

function html(title: string, body: string, head = ''): string {
	return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${xmlEscape(title)}</title>${head}</head>\n<body>${body}</body></html>\n`;
}

const CHALLENGE_PAGE = html(
	'Just a moment...',
	'<h1>Checking your browser…</h1><p>This process is automatic. Your browser will redirect to your requested content shortly.</p><noscript>Please enable JavaScript.</noscript>'
);

export async function startFakeSource(options: StartOptions = {}): Promise<FakeSource> {
	const ds: ResolvedDataset = resolveDataset(options.dataset);
	const sessionActive: Record<Platform, boolean> = { gaiagps: true, alltrails: true };
	let faults: FaultState[] = [];
	let entries: LiveEntry[] = [];
	let port = 0;
	let gaia: GaiaData | null = null;
	let alltrails: AllTrailsData | null = null;
	const envs = {} as Record<Platform, Env>;

	const setFaults = (list: Fault[]): void => {
		faults = list.map((fault) => ({ fault, regex: new RegExp(fault.match), seen: 0 }));
	};

	const pickFault = (platform: Platform, target: string): Fault | null => {
		for (const state of faults) {
			const f = state.fault;
			if (f.platform !== undefined && f.platform !== platform) continue;
			if (!state.regex.test(target)) continue;
			const n = state.seen++;
			const skip = f.skip ?? 0;
			if (n < skip) continue;
			if (f.count !== undefined && n >= skip + f.count) continue;
			return f;
		}
		return null;
	};

	const sendJson = (res: ServerResponse, status: number, body: unknown, head: boolean): void => {
		const bytes = Buffer.from(JSON.stringify(body), 'utf8');
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': String(bytes.length),
			'Cache-Control': 'no-store'
		});
		res.end(head ? undefined : bytes);
	};

	const sendText = (
		res: ServerResponse,
		status: number,
		contentType: string,
		body: string | Buffer,
		head: boolean,
		extra: Record<string, string | string[]> = {}
	): void => {
		const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
		res.writeHead(status, {
			'Content-Type': contentType,
			'Content-Length': String(bytes.length),
			'Cache-Control': 'no-store',
			...extra
		});
		res.end(head ? undefined : bytes);
	};

	const sendReply = (res: ServerResponse, reply: Reply, head: boolean, drift: boolean): void => {
		switch (reply.kind) {
			case 'json': {
				let body = reply.body;
				if (drift && reply.listing && reply.status === 200) {
					// A bare-array listing that grows an envelope.
					body = { count: (body as unknown[]).length, results: body };
				} else if (
					drift &&
					reply.listingKey !== undefined &&
					reply.status === 200 &&
					!Array.isArray(body)
				) {
					const renamed = reply.listingKey === 'results' ? 'data' : 'entries';
					body = Object.fromEntries(
						Object.entries(body).map(([k, v]) => [k === reply.listingKey ? renamed : k, v])
					);
				}
				sendJson(res, reply.status, body, head);
				return;
			}
			case 'bytes':
				sendText(res, reply.status, reply.contentType, reply.body, head);
				return;
			case 'photo':
				streamPhoto(res, reply.spec, head);
				return;
		}
	};

	const handleControl = async (
		req: IncomingMessage,
		res: ServerResponse,
		url: URL
	): Promise<void> => {
		const action = url.pathname.slice('/__control/'.length);
		const platform = url.searchParams.get('platform');
		const method = req.method ?? 'GET';
		if ((action === 'login' || action === 'logout') && method === 'POST') {
			if (!isPlatform(platform)) return sendJson(res, 400, { error: 'platform required' }, false);
			sessionActive[platform] = action === 'login';
			return sendJson(res, 200, { ok: true, platform, active: sessionActive[platform] }, false);
		}
		if (action === 'faults' && method === 'POST') {
			let parsed: unknown;
			try {
				parsed = JSON.parse((await readBody(req)) || '[]');
				if (!Array.isArray(parsed)) throw new Error('expected a JSON array of faults');
				setFaults(parsed as Fault[]);
			} catch (error) {
				return sendJson(res, 400, { error: String(error) }, false);
			}
			return sendJson(res, 200, { ok: true, faults: faults.length }, false);
		}
		if (action === 'stats' && method === 'GET') {
			if (!isPlatform(platform)) return sendJson(res, 400, { error: 'platform required' }, false);
			const stats = computeStats(entries, platform);
			// JSON has no Infinity: minApiGapMs is null with fewer than two api requests.
			return sendJson(
				res,
				200,
				{ ...stats, minApiGapMs: Number.isFinite(stats.minApiGapMs) ? stats.minApiGapMs : null },
				false
			);
		}
		if (action === 'log' && method === 'GET') return sendJson(res, 200, snapshotLog(), false);
		if (action === 'reset-log' && method === 'POST') {
			entries = [];
			return sendJson(res, 200, { ok: true }, false);
		}
		return sendJson(res, 404, { error: 'unknown control endpoint' }, false);
	};

	const handlePage = (
		req: IncomingMessage,
		res: ServerResponse,
		platform: Platform,
		url: URL,
		authed: boolean
	): void => {
		const method = req.method ?? 'GET';
		const head = method === 'HEAD';
		const label = PLATFORM_LABEL[platform];
		const path = url.pathname;
		if (path === '/robots.txt') {
			return sendText(
				res,
				200,
				'text/plain; charset=utf-8',
				'User-agent: *\nDisallow: /api/\n',
				head
			);
		}
		if (path === '/login' && method === 'POST') {
			req.resume();
			sessionActive[platform] = true;
			res.writeHead(303, {
				Location: '/',
				'Set-Cookie': `${COOKIE_NAME}=${SENTINELS.sessionCookie[platform]}; Path=/; HttpOnly; SameSite=Lax`,
				'Content-Length': '0'
			});
			res.end();
			return;
		}
		if (path === '/logout' && method === 'POST') {
			req.resume();
			sessionActive[platform] = false;
			res.writeHead(303, {
				Location: '/',
				'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
				'Content-Length': '0'
			});
			res.end();
			return;
		}
		if (method !== 'GET' && method !== 'HEAD') {
			return sendText(res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n', head);
		}
		const page = (status: number, title: string, body: string, headHtml = ''): void =>
			sendText(res, status, 'text/html; charset=utf-8', html(title, body, headHtml), head);
		if (path === '/') {
			if (authed) {
				return page(
					200,
					label,
					`<h1>${label}</h1><p>Signed in as <span id="account-email">${SENTINELS.email}</span>.</p>` +
						'<form method="post" action="/logout"><button type="submit">Sign out</button></form>',
					`<meta name="csrf-token" content="${SENTINELS.csrfToken}">`
				);
			}
			return page(
				200,
				label,
				`<h1>${label}</h1><p><a href="/login">Log in</a> to see your maps.</p>`
			);
		}
		if (path === '/login') {
			return page(
				200,
				`Log in — ${label}`,
				`<h1>Log in to ${label}</h1><form method="post" action="/login">` +
					'<label>E-mail <input type="email" name="email"></label> ' +
					'<label>Password <input type="password" name="password"></label> ' +
					'<button type="submit">Log in</button></form>'
			);
		}
		const hike = /^\/hike\/([^/]+)\/?$/.exec(path);
		if (platform === 'gaiagps' && hike) {
			return page(200, `Hike ${hike[1]!}`, `<h1>Hike ${xmlEscape(hike[1]!)}</h1>`);
		}
		const trail = /^\/trail\/(.+?)\/?$/.exec(path);
		if (platform === 'alltrails' && trail) {
			const found = trailBySlug(trail[1]!);
			if (found) return page(200, found.name, `<h1>${xmlEscape(found.name)}</h1>`);
		}
		return page(404, 'Not found', '<h1>Not found</h1>');
	};

	const serve = (
		req: IncomingMessage,
		res: ServerResponse,
		platform: Platform,
		cdn: boolean,
		url: URL,
		drift: boolean
	): void => {
		const method = req.method ?? 'GET';
		const head = method === 'HEAD';
		if (cdn) {
			const reply =
				method === 'GET' || head
					? platform === 'gaiagps'
						? handleGaiaCdn(gaia!, url.pathname)
						: handleAllTrailsCdn(alltrails!, url.pathname)
					: null;
			if (reply) return sendReply(res, reply, head, false);
			return sendText(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head);
		}
		const authed =
			sessionActive[platform] &&
			readCookie(req.headers.cookie, COOKIE_NAME) === SENTINELS.sessionCookie[platform];
		if (!url.pathname.startsWith('/api/')) return handlePage(req, res, platform, url, authed);
		// Photo URLs on both sites answer without a session and bounce to the photo host: Gaia's to
		// a signed URL, AllTrails' only when the app key rides along.
		const atPhoto =
			platform === 'alltrails'
				? allTrailsPhotoRedirect(alltrails!, envs.alltrails, url.pathname, url.searchParams)
				: null;
		if (atPhoto && 'status' in atPhoto) {
			req.resume();
			return sendJson(res, atPhoto.status, { errors: [{ code: 'missing_key' }] }, head);
		}
		const photoUrl =
			platform === 'gaiagps'
				? gaiaPhotoRedirect(gaia!, envs.gaiagps, url.pathname)
				: (atPhoto?.location ?? null);
		if (photoUrl) {
			req.resume();
			res.writeHead(302, {
				Location: photoUrl,
				'Content-Length': '0',
				'Cache-Control': 'no-store'
			});
			res.end();
			return;
		}
		if (!authed) {
			req.resume();
			if (platform === 'gaiagps') {
				// The account endpoint answers anonymously; everything else is a bare 403.
				if (url.pathname === '/api/v3/user/') return sendJson(res, 200, GAIA_ANONYMOUS_USER, head);
				return sendText(res, 403, 'text/html; charset=utf-8', '', head);
			}
			res.writeHead(302, {
				Location: '/login',
				'Content-Length': '0',
				'Cache-Control': 'no-store'
			});
			res.end();
			return;
		}
		const apiReq = { method, path: url.pathname, query: url.searchParams, headers: req.headers };
		const reply =
			platform === 'gaiagps'
				? handleGaiaApi(gaia!, apiReq)
				: handleAllTrailsApi(alltrails!, ds, apiReq);
		sendReply(res, reply, head, drift);
	};

	const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
		const url = new URL(req.url ?? '/', 'http://fake-source.invalid');
		if (url.pathname.startsWith('/__control/')) {
			handleControl(req, res, url).catch(() => {
				if (!res.headersSent) sendJson(res, 500, { error: 'control failure' }, false);
				else res.destroy();
			});
			return;
		}
		const route = routeHost(req.headers.host);
		if (!route) {
			sendText(
				res,
				404,
				'text/plain; charset=utf-8',
				`fake-source: unknown host ${JSON.stringify(req.headers.host ?? '')}\n`,
				req.method === 'HEAD'
			);
			return;
		}
		if (!gaia || !alltrails) {
			sendText(res, 503, 'text/plain; charset=utf-8', 'fake-source: starting\n', false);
			return;
		}
		const { platform, cdn } = route;
		const target = url.pathname + url.search;
		// Gaia's photo redirects live under /api/ but are fetched as assets, not as API calls.
		const photoRedirect =
			/^\/api\/objects\/photo\/[^/]+\/image\//.test(url.pathname) ||
			/^\/api\/alltrails\/(v3\/)?photos\/\d+\/image$/.test(url.pathname);
		const lane: Lane =
			cdn || photoRedirect ? 'asset' : url.pathname.startsWith('/api/') ? 'api' : 'page';
		const start = performance.now();
		const entry: LiveEntry = {
			platform,
			lane,
			method: req.method ?? 'GET',
			path: target,
			status: 0,
			start,
			end: start,
			open: true
		};
		entries.push(entry);
		let timer: NodeJS.Timeout | null = null;
		res.once('close', () => {
			if (timer) clearTimeout(timer);
			entry.end = performance.now();
			entry.status = res.writableFinished ? res.statusCode : 0;
			entry.open = false;
		});
		res.on('error', () => {});
		req.on('error', () => {});

		const run = (drift: boolean): void => {
			try {
				serve(req, res, platform, cdn, url, drift);
			} catch (error) {
				if (!res.headersSent) sendJson(res, 500, { error: String(error) }, false);
				else res.destroy();
			}
		};

		const fault = pickFault(platform, target);
		const action = fault?.action;
		if (!action) return run(false);
		const head = req.method === 'HEAD';
		switch (action.kind) {
			case 'status': {
				req.resume();
				const extra: Record<string, string> = {};
				if (action.retryAfter !== undefined) extra['Retry-After'] = String(action.retryAfter);
				const body = action.body ?? JSON.stringify({ detail: `Injected fault: ${action.status}` });
				const type =
					action.body === undefined || /^\s*[[{]/.test(action.body)
						? 'application/json; charset=utf-8'
						: 'text/plain; charset=utf-8';
				return sendText(res, action.status, type, body, head, extra);
			}
			case 'challenge':
				req.resume();
				return sendText(res, 200, 'text/html; charset=utf-8', CHALLENGE_PAGE, head);
			case 'drop':
				if (action.when === 'mid-response') {
					// Promise a body, send a little of it, then kill the socket. Unlike a reset before
					// any response bytes, browsers do not transparently re-send the request for this.
					res.writeHead(200, {
						'Content-Type': 'application/json; charset=utf-8',
						'Content-Length': '65536'
					});
					res.write('{"truncated":', () => req.socket.destroy());
					return;
				}
				req.socket.destroy();
				return;
			case 'expire-session':
				sessionActive[platform] = false;
				return run(false);
			case 'schema-drift':
				return run(true);
			case 'delay':
				timer = setTimeout(
					() => {
						timer = null;
						if (!res.destroyed) run(false);
					},
					Math.max(0, action.ms)
				);
				return;
		}
	};

	const snapshotLog = (): RequestLogEntry[] => {
		const now = performance.now();
		return entries.map(({ open, ...e }) => (open ? { ...e, end: now } : e));
	};

	// --- listen -------------------------------------------------------------------------------
	const servers: Server[] = [];
	const listen = (host: string, p: number): Promise<Server> =>
		new Promise((resolve, reject) => {
			const server = createServer(onRequest);
			server.keepAliveTimeout = 5_000;
			server.once('error', reject);
			server.listen(p, host, () => {
				server.removeListener('error', reject);
				resolve(server);
			});
		});

	const v4 = await listen('127.0.0.1', options.port ?? 4610);
	servers.push(v4);
	port = (v4.address() as AddressInfo).port;
	try {
		servers.push(await listen('::1', port));
	} catch {
		// No IPv6 loopback (or the port is taken there): IPv4 only.
	}
	for (const platform of PLATFORMS) {
		envs[platform] = {
			origin: `http://${SITE_HOST[platform]}:${port}`,
			cdnOrigin: `http://cdn.${SITE_HOST[platform]}:${port}`
		};
	}
	gaia = buildGaia(envs.gaiagps, ds);
	alltrails = buildAllTrails(envs.alltrails, ds);
	const gaiaData = gaia;
	const atData = alltrails;

	function objects(platform: 'gaiagps'): GaiaObjects;
	function objects(platform: 'alltrails'): AllTrailsObjects;
	function objects(platform: Platform): GaiaObjects | AllTrailsObjects;
	function objects(platform: Platform): GaiaObjects | AllTrailsObjects {
		return platform === 'gaiagps' ? gaiaData.objects() : atData.objects();
	}

	return {
		port,
		origin: (platform) => envs[platform].origin,
		assetOrigin: (platform) => envs[platform].cdnOrigin,
		sessionCookie: (platform) => ({
			name: COOKIE_NAME,
			value: SENTINELS.sessionCookie[platform],
			domain: SITE_HOST[platform],
			path: '/',
			httpOnly: true,
			secure: false,
			sameSite: 'Lax'
		}),
		setFaults,
		login: (platform) => {
			sessionActive[platform] = true;
		},
		logout: (platform) => {
			sessionActive[platform] = false;
		},
		resetLog: () => {
			entries = [];
		},
		log: snapshotLog,
		stats: (platform) => computeStats(entries, platform),
		expected: (platform) => (platform === 'gaiagps' ? gaiaData.expected() : atData.expected()),
		nativeGpx: (platform, kind, id) => {
			// AllTrails has no GPX export to serve.
			const line =
				platform === 'gaiagps'
					? (kind === 'track' ? gaiaData.tracks : gaiaData.routes).find((l) => l.id === String(id))
					: undefined;
			if (!line) throw new Error(`fake-source: no ${platform} ${kind} with id ${String(id)}`);
			return line.gpx;
		},
		objects,
		close: async () => {
			await Promise.all(
				servers.map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
							server.closeAllConnections();
						})
				)
			);
		}
	};
}
