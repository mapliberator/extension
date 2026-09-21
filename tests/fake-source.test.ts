// @vitest-environment node
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	SENTINELS,
	decodePolyline,
	encodePolyline,
	startFakeSource,
	trailCoordinatesP5,
	type FakeSource,
	type Platform
} from '../tools/fake-source/index.ts';

interface HttpResult {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
	text: string;
	json<T = any>(): T;
}

interface HttpOptions {
	method?: string;
	cookie?: string | false;
	body?: string;
	/** Count the body instead of buffering it. */
	discard?: boolean;
}

const HOSTS: Record<Platform, string> = {
	gaiagps: 'gaia.localhost',
	alltrails: 'alltrails.localhost'
};

/** node:http to 127.0.0.1 with an explicit Host header (fetch cannot set Host). */
function http(
	fake: FakeSource,
	host: string,
	path: string,
	opts: HttpOptions = {}
): Promise<HttpResult & { length: number }> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { Host: `${host}:${fake.port}` };
		if (typeof opts.cookie === 'string') headers.Cookie = opts.cookie;
		if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
		const req = httpRequest(
			{
				host: '127.0.0.1',
				port: fake.port,
				path,
				method: opts.method ?? 'GET',
				headers,
				agent: false
			},
			(res) => {
				const chunks: Buffer[] = [];
				let length = 0;
				res.on('data', (chunk: Buffer) => {
					length += chunk.length;
					if (!opts.discard) chunks.push(chunk);
				});
				res.on('error', reject);
				res.on('end', () => {
					const body = Buffer.concat(chunks);
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body,
						length,
						text: body.toString('utf8'),
						json: () => JSON.parse(body.toString('utf8'))
					});
				});
			}
		);
		req.on('error', reject);
		req.end(opts.body);
	});
}

function cookieOf(fake: FakeSource, platform: Platform): string {
	const c = fake.sessionCookie(platform);
	return `${c.name}=${c.value}`;
}

/** Authenticated API/site request. */
function site(fake: FakeSource, platform: Platform, path: string, opts: HttpOptions = {}) {
	return http(fake, HOSTS[platform], path, {
		...opts,
		cookie: opts.cookie === false ? false : (opts.cookie ?? cookieOf(fake, platform))
	});
}

function toPath(url: string): { host: string; path: string } {
	const u = new URL(url);
	return { host: u.hostname, path: u.pathname + u.search };
}

async function gaiaAll(fake: FakeSource, type: string, pageSize = 50): Promise<any[]> {
	const out: any[] = [];
	let path: string | null = `/api/v3/${type}/?page=1&page_size=${pageSize}`;
	while (path) {
		const page: any = (await site(fake, 'gaiagps', path)).json();
		out.push(...page.results);
		path = page.next ? toPath(page.next).path : null;
	}
	return out;
}

async function atAll(fake: FakeSource, resource: string, limit = 50): Promise<any[]> {
	const out: any[] = [];
	let cursor: string | null = null;
	do {
		const qs: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
		const page: any = (
			await site(fake, 'alltrails', `/api/alltrails/v3/users/7001/${resource}${qs}`)
		).json();
		out.push(...page.items);
		cursor = page.meta.nextCursor;
	} while (cursor);
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('fake-source (small dataset)', () => {
	let fake: FakeSource;

	beforeAll(async () => {
		fake = await startFakeSource({ port: 0, dataset: 'small' });
	});
	afterAll(async () => {
		await fake.close();
	});
	afterEach(() => {
		fake.setFaults([]);
		fake.login('gaiagps');
		fake.login('alltrails');
		fake.resetLog();
	});

	it('binds an ephemeral port and reflects it in origins and cookies', () => {
		expect(fake.port).toBeGreaterThan(0);
		expect(fake.origin('gaiagps')).toBe(`http://gaia.localhost:${fake.port}`);
		expect(fake.origin('alltrails')).toBe(`http://alltrails.localhost:${fake.port}`);
		expect(fake.assetOrigin('gaiagps')).toBe(`http://cdn.gaia.localhost:${fake.port}`);
		expect(fake.sessionCookie('gaiagps')).toEqual({
			name: 'fs_session',
			value: SENTINELS.sessionCookie.gaiagps,
			domain: 'gaia.localhost',
			path: '/',
			httpOnly: true,
			secure: false,
			sameSite: 'Lax'
		});
		expect(fake.sessionCookie('alltrails').domain).toBe('alltrails.localhost');
		expect(fake.sessionCookie('alltrails').value).toBe(SENTINELS.sessionCookie.alltrails);
	});

	it('routes by Host and sends no CORS headers', async () => {
		const unknown = await http(fake, 'example.com', '/');
		expect(unknown.status).toBe(404);
		const me = await site(fake, 'gaiagps', '/api/v3/me/');
		expect(me.status).toBe(200);
		expect(Object.keys(me.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
		// AllTrails paths do not exist on the Gaia host and vice versa.
		expect((await site(fake, 'gaiagps', '/api/alltrails/v3/me')).status).toBe(404);
		expect((await site(fake, 'alltrails', '/api/v3/me/')).status).toBe(404);
	});

	describe('sessions', () => {
		it('Gaia answers 401 JSON without a valid, active session', async () => {
			const none = await site(fake, 'gaiagps', '/api/v3/track/', { cookie: false });
			expect(none.status).toBe(401);
			expect(none.json()).toEqual({ detail: 'Authentication credentials were not provided.' });
			const wrong = await site(fake, 'gaiagps', '/api/v3/track/', { cookie: 'fs_session=nope' });
			expect(wrong.status).toBe(401);
			// The other platform's cookie is not valid here.
			const cross = await site(fake, 'gaiagps', '/api/v3/me/', {
				cookie: cookieOf(fake, 'alltrails')
			});
			expect(cross.status).toBe(401);

			fake.logout('gaiagps');
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(401);
			expect((await site(fake, 'alltrails', '/api/alltrails/v3/me')).status).toBe(200);
			fake.login('gaiagps');
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(200);
		});

		it('AllTrails redirects to /login, which is a 200 HTML page', async () => {
			const res = await site(fake, 'alltrails', '/api/alltrails/v3/me', { cookie: false });
			expect(res.status).toBe(302);
			expect(res.headers.location).toBe('/login');
			const login = await site(fake, 'alltrails', '/login', { cookie: false });
			expect(login.status).toBe(200);
			expect(login.headers['content-type']).toMatch(/^text\/html/);
			expect(login.text).toContain('<form');
		});

		it('POST /login sets the cookie, activates the session and redirects home', async () => {
			fake.logout('alltrails');
			const res = await site(fake, 'alltrails', '/login', {
				method: 'POST',
				cookie: false,
				body: 'email=a&password=b'
			});
			expect(res.status).toBe(303);
			expect(res.headers.location).toBe('/');
			const setCookie = res.headers['set-cookie']?.[0] ?? '';
			expect(setCookie).toContain(`fs_session=${SENTINELS.sessionCookie.alltrails}`);
			expect(setCookie).toMatch(/HttpOnly/);
			expect(setCookie).toMatch(/Path=\//);
			expect(setCookie).not.toMatch(/Domain=/i);
			expect((await site(fake, 'alltrails', '/api/alltrails/v3/me')).status).toBe(200);
		});

		it('serves the home page and robots.txt', async () => {
			for (const platform of ['gaiagps', 'alltrails'] as Platform[]) {
				const signedIn = await site(fake, platform, '/');
				expect(signedIn.status).toBe(200);
				expect(signedIn.text).toContain(SENTINELS.email);
				expect(signedIn.text).toContain(
					`<meta name="csrf-token" content="${SENTINELS.csrfToken}">`
				);
				const signedOut = await site(fake, platform, '/', { cookie: false });
				expect(signedOut.text).toContain('href="/login"');
				expect(signedOut.text).not.toContain(SENTINELS.email);
				const robots = await site(fake, platform, '/robots.txt', { cookie: false });
				expect(robots.status).toBe(200);
				expect(robots.headers['content-type']).toMatch(/^text\/plain/);
			}
		});

		it('control endpoints work on any host and are never logged', async () => {
			fake.resetLog();
			const out = await http(fake, '127.0.0.1', '/__control/logout?platform=gaiagps', {
				method: 'POST'
			});
			expect(out.status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(401);
			await http(fake, 'gaia.localhost', '/__control/login?platform=gaiagps', { method: 'POST' });
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(200);

			const faults = await http(fake, 'localhost', '/__control/faults', {
				method: 'POST',
				body: JSON.stringify([{ match: '/me', action: { kind: 'status', status: 500 } }])
			});
			expect(faults.status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(500);

			const stats = (await http(fake, 'localhost', '/__control/stats?platform=gaiagps')).json();
			expect(stats.apiRequests).toBe(3);
			expect(fake.log().every((e) => !e.path.startsWith('/__control/'))).toBe(true);
			expect(fake.log()).toHaveLength(3);
		});
	});

	describe('Gaia shape', () => {
		it('clamps page_size and paginates with absolute next/previous URLs', async () => {
			const p1 = (await site(fake, 'gaiagps', '/api/v3/track/?page=1&page_size=50')).json();
			expect(p1.count).toBe(7);
			expect(p1.results).toHaveLength(3);
			expect(p1.previous).toBeNull();
			expect(p1.next).toBe(`${fake.origin('gaiagps')}/api/v3/track/?page=2&page_size=3`);
			const p2 = (await site(fake, 'gaiagps', toPath(p1.next).path)).json();
			expect(p2.previous).toBe(`${fake.origin('gaiagps')}/api/v3/track/?page=1&page_size=3`);
			const p3 = (await site(fake, 'gaiagps', toPath(p2.next).path)).json();
			expect(p3.results).toHaveLength(1);
			expect(p3.next).toBeNull();
			expect((await site(fake, 'gaiagps', '/api/v3/track/?page=4&page_size=3')).status).toBe(404);

			const small = (await site(fake, 'gaiagps', '/api/v3/track/?page_size=2')).json();
			expect(small.results).toHaveLength(2);
			expect(small.next).toContain('page_size=2');
		});

		it('me carries the e-mail and CSRF sentinels', async () => {
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).json()).toEqual({
				id: 'gu-1001',
				display_name: 'Test H.',
				email: SENTINELS.email,
				csrf_token: SENTINELS.csrfToken,
				units: 'imperial'
			});
		});

		it('listings match expected() for owned objects', async () => {
			const expected = fake.expected('gaiagps');
			expect(expected.account).toEqual({ id: 'gu-1001', displayName: 'Test H.' });
			expect(expected.counts).toEqual({
				tracks: 6,
				routes: 4,
				waypoints: 5,
				areas: 2,
				collections: 4,
				photos: 4
			});
			const listed: Record<string, number> = { track: 7, route: 5, waypoint: 5, area: 2, photo: 5 };
			const key = {
				track: 'tracks',
				route: 'routes',
				waypoint: 'waypoints',
				area: 'areas',
				photo: 'photos'
			} as const;
			for (const type of Object.keys(key) as (keyof typeof key)[]) {
				const all = await gaiaAll(fake, type);
				expect(all).toHaveLength(listed[type]!);
				const own = all.filter((o) => o.user_id === 'gu-1001');
				expect(own.map((o) => o.id)).toEqual(expected.ids[key[type]]);
				expect(own).toHaveLength(expected.counts[key[type]]);
				for (const o of all) {
					expect(o.time_created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
					expect(o.time_created.endsWith('+00:00')).toBe(false);
					if (o.user_id === 'gu-1001') {
						expect(o.user_email).toBe(SENTINELS.email);
						expect('user_name' in o).toBe(false);
					} else {
						expect(o.user_id).toBe('gu-2002');
						expect(o.user_name).toBe(SENTINELS.otherUserName);
						expect(o.user_email).toBe(SENTINELS.otherUserEmail);
						expect(o.notes).toBe(SENTINELS.otherUserDescription);
					}
				}
			}
		});

		it('folders: nesting, many-to-many membership, saved hikes, shared folder', async () => {
			const folders = await gaiaAll(fake, 'folder');
			expect(folders).toHaveLength(4);
			const own = folders.filter((f) => f.user_id === 'gu-1001');
			expect(own).toHaveLength(3);
			expect(own.filter((f) => f.parent !== null)).toHaveLength(1);
			expect(own.map((f) => f.id)).toContain(own.find((f) => f.parent !== null).parent);
			const memberships = own.flatMap((f) => f.tracks as string[]);
			expect(new Set(memberships).size).toBeLessThan(memberships.length);

			const shared = folders.filter((f) => f.user_id !== 'gu-1001');
			expect(shared).toHaveLength(1);
			expect(shared[0].shared_by).toEqual({
				name: SENTINELS.otherUserName,
				email: SENTINELS.otherUserEmail
			});
			for (const f of own) expect(f.shared_by).toBeNull();

			const withHikes = own.filter((f) => f.saved_hikes.length > 0);
			expect(withHikes).toHaveLength(1);
			expect(withHikes[0].tracks).toContain('gt-9001');
			const hikes = withHikes[0].saved_hikes as any[];
			expect(hikes).toHaveLength(2);
			expect(hikes.filter((h) => h.user_notes !== null)).toHaveLength(1);
			for (const h of hikes) {
				expect(h.description).toContain(SENTINELS.trailDescription);
				expect(h.geometry.coordinates.length).toBeGreaterThanOrEqual(4);
				expect(h.geometry.coordinates.length).toBeLessThanOrEqual(10);
				const text = JSON.stringify(h.geometry);
				for (const c of SENTINELS.trailCoordinates) expect(text).toContain(c);
				expect(h.url.startsWith(fake.origin('gaiagps'))).toBe(true);
				const th = JSON.stringify(h.trailhead);
				for (const c of [...SENTINELS.trailCoordinates, ...trailCoordinatesP5]) {
					expect(th).not.toContain(c);
				}
			}
			expect(fake.expected('gaiagps').references).toEqual(
				hikes.map((h) => ({
					name: h.name,
					url: h.url,
					sourceId: h.id,
					coordinate: [h.trailhead.longitude, h.trailhead.latitude]
				}))
			);
		});

		it('exercises the filename sanitizer', async () => {
			const tracks = (await gaiaAll(fake, 'track')).filter((t) => t.user_id === 'gu-1001');
			const titles: string[] = tracks.map((t) => t.title);
			expect(titles.some((t) => t.includes('/') && t.includes('..'))).toBe(true);
			expect(
				titles.some((t) => /^[^\p{L}\p{N}]+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t))
			).toBe(true);
			expect(titles.some((t) => /[éêÜà]/.test(t))).toBe(true);
			expect(titles.some((t) => t.length > 100)).toBe(true);
			expect(new Set(titles).size).toBeLessThan(titles.length);
		});

		it('native GPX: same bytes as nativeGpx(), stable, well-formed, consistent with JSON', async () => {
			const expected = fake.expected('gaiagps');
			let multiSegment = 0;
			let nonAscii = 0;
			for (const id of expected.ids.tracks) {
				const a = await site(fake, 'gaiagps', `/api/v3/track/${id}.gpx`);
				const b = await site(fake, 'gaiagps', `/api/v3/track/${id}.gpx`);
				expect(a.status).toBe(200);
				expect(a.headers['content-type']).toBe('application/gpx+xml');
				expect(a.body.equals(fake.nativeGpx('gaiagps', 'track', id))).toBe(true);
				expect(a.body.equals(b.body)).toBe(true);
				expect(a.body.subarray(0, 5).toString()).toBe('<?xml');
				expect(a.text).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
				expect(a.text).toContain('xmlns:gaia=');
				expect(a.text).toContain('<metadata>');
				expect(a.text).toContain('<gaia:');
				expect(a.text.trimEnd().endsWith('</gpx>')).toBe(true);
				for (const s of sentinelStrings()) expect(a.text).not.toContain(s);
				// eslint-disable-next-line no-control-regex
				if (/<name>[^<]*[^\x00-\x7f]/.test(a.text)) nonAscii++;

				const detail = (await site(fake, 'gaiagps', `/api/v3/track/${id}/`)).json();
				expect(detail.geometry.type).toBe('MultiLineString');
				const coords: number[][][] = detail.geometry.coordinates;
				if (coords.length > 1) multiSegment++;
				expect((a.text.match(/<trkseg>/g) ?? []).length).toBe(coords.length);
				const flat = coords.flat();
				expect(flat.length).toBeGreaterThanOrEqual(24);
				expect(flat.length).toBeLessThanOrEqual(400);
				const pts = [
					...a.text.matchAll(
						/<trkpt lat="([^"]+)" lon="([^"]+)">\s*<ele>([^<]+)<\/ele>\s*<time>([^<]+)<\/time>/g
					)
				];
				expect(pts).toHaveLength(flat.length);
				pts.forEach((m, i) => {
					const [lon, lat, ele, t] = flat[i]!;
					expect(Number(m[1])).toBe(lat);
					expect(Number(m[2])).toBe(lon);
					expect(Number(m[3])).toBe(ele);
					expect(Date.parse(m[4]!) / 1000).toBe(t);
				});
			}
			expect(multiSegment).toBeGreaterThanOrEqual(1);
			expect(nonAscii).toBeGreaterThanOrEqual(1);

			for (const id of expected.ids.routes) {
				const gpx = await site(fake, 'gaiagps', `/api/v3/route/${id}.gpx`);
				expect(gpx.body.equals(fake.nativeGpx('gaiagps', 'route', id))).toBe(true);
				expect(gpx.text).toContain('<rte>');
				expect(gpx.text).not.toContain('<trk>');
				const detail = (await site(fake, 'gaiagps', `/api/v3/route/${id}/`)).json();
				const flat: number[][] = detail.geometry.coordinates.flat();
				expect(flat[0]).toHaveLength(3);
				expect((gpx.text.match(/<rtept /g) ?? []).length).toBe(flat.length);
			}
			expect(() => fake.nativeGpx('gaiagps', 'track', 'nope')).toThrow();
		});

		it('photos: CDN URLs, content types, deterministic bytes, Content-Length', async () => {
			const photos = await gaiaAll(fake, 'photo');
			const types = new Set<string>();
			const bodies: Buffer[] = [];
			for (const p of photos) {
				expect(p.fullsize_url).toBe(`${fake.assetOrigin('gaiagps')}/photos/${p.id}/full`);
				const { host, path } = toPath(p.fullsize_url);
				expect(path).not.toMatch(/\.\w+$/);
				const a = await http(fake, host, path);
				const b = await http(fake, host, path);
				expect(a.status).toBe(200);
				expect(Number(a.headers['content-length'])).toBe(a.body.length);
				expect(a.body.equals(b.body)).toBe(true);
				const type = String(a.headers['content-type']);
				types.add(type);
				if (type === 'image/jpeg')
					expect(a.body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
				if (type === 'image/png') expect(a.body.subarray(1, 4).toString()).toBe('PNG');
				if (type === 'image/heic') expect(a.body.subarray(4, 12).toString()).toBe('ftypheic');
				bodies.push(a.body);
			}
			expect(types).toEqual(new Set(['image/jpeg', 'image/png', 'image/heic']));
			expect(new Set(bodies.map((b) => b.toString('base64'))).size).toBe(bodies.length);
			const own = photos.filter((p) => p.user_id === 'gu-1001');
			expect(own.filter((p) => p.attached_to === null)).toHaveLength(1);
			expect((await http(fake, 'cdn.gaia.localhost', '/photos/nope/full')).status).toBe(404);
			const stats = fake.stats('gaiagps');
			expect(stats.assetRequests).toBe(photos.length * 2 + 1);
		});
	});

	describe('AllTrails shape', () => {
		const base = '/api/alltrails/v3';

		it('me and stats', async () => {
			const me = (await site(fake, 'alltrails', `${base}/me`)).json();
			expect(me.user.id).toBe(7001);
			expect(me.user.email).toBe(SENTINELS.email);
			expect(me.csrfToken).toBe(SENTINELS.csrfToken);
			const stats = (await site(fake, 'alltrails', `${base}/users/7001/stats`)).json();
			expect(stats).toEqual({ activities: 5, maps: 3, photos: 4, completed: 2 });
			expect((await site(fake, 'alltrails', `${base}/users/1/activities`)).status).toBe(403);
		});

		it('clamps limit and walks cursors', async () => {
			const p1 = (await site(fake, 'alltrails', `${base}/users/7001/activities?limit=50`)).json();
			expect(p1.items).toHaveLength(3);
			expect(typeof p1.meta.nextCursor).toBe('string');
			const p2 = (
				await site(
					fake,
					'alltrails',
					`${base}/users/7001/activities?limit=50&cursor=${encodeURIComponent(p1.meta.nextCursor)}`
				)
			).json();
			expect(p2.items).toHaveLength(2);
			expect(p2.meta.nextCursor).toBeNull();
			const one = (await site(fake, 'alltrails', `${base}/users/7001/activities?limit=1`)).json();
			expect(one.items).toHaveLength(1);
			expect(
				(await site(fake, 'alltrails', `${base}/users/7001/activities?cursor=garbage`)).status
			).toBe(400);
		});

		it('listings match expected() for owned objects', async () => {
			const expected = fake.expected('alltrails');
			expect(expected.account).toEqual({ id: '7001', displayName: 'Test H.' });
			expect(expected.counts).toEqual({
				tracks: 4,
				routes: 3,
				waypoints: 4,
				areas: 0,
				collections: 3,
				photos: 3
			});
			const activities = await atAll(fake, 'activities');
			expect(activities).toHaveLength(5);
			const ownActs = activities.filter((a) => a.user.id === 7001);
			expect(ownActs.map((a) => String(a.id))).toEqual(expected.ids.tracks);
			const other = activities.filter((a) => a.user.id !== 7001);
			expect(other).toHaveLength(1);
			expect(other[0].user.name).toBe(SENTINELS.otherUserName);
			expect(other[0].notes).toBe(SENTINELS.otherUserDescription);
			for (const a of activities) {
				expect(typeof a.id).toBe('number');
				expect(Number.isInteger(a.createdAt)).toBe(true);
				expect(typeof a.summaryStats.timeTotal).toBe('number');
			}

			const maps = await atAll(fake, 'maps');
			expect(maps.map((m) => String(m.id))).toEqual(expected.ids.routes);
			expect(maps.flatMap((m) => m.waypoints.map((w: any) => String(w.id)))).toEqual(
				expected.ids.waypoints
			);
			for (const m of maps) {
				expect('timeTotal' in m.summaryStats).toBe(false);
				expect(typeof m.description).toBe('string');
			}
			expect(expected.ids.areas).toEqual([]);

			const photos = await atAll(fake, 'photos');
			expect(photos).toHaveLength(4);
			const ownPhotos = photos.filter((p) => p.user.id === 7001);
			expect(ownPhotos.map((p) => String(p.id))).toEqual(expected.ids.photos);
			expect(ownPhotos.filter((p) => p.urls.original === undefined)).toHaveLength(1);
			expect(ownPhotos.filter((p) => p.attachedTo?.type === 'trail')).toHaveLength(1);
			for (const p of photos) {
				for (const [rendition, url] of Object.entries<string>(p.urls)) {
					expect(url).toBe(`${fake.assetOrigin('alltrails')}/p/${p.id}/${rendition}`);
					const { host, path } = toPath(url);
					const res = await http(fake, host, path);
					expect(res.status).toBe(200);
					expect(Number(res.headers['content-length'])).toBe(res.body.length);
				}
			}
		});

		it('lists, completed trails and references', async () => {
			const lists = await atAll(fake, 'lists');
			expect(lists).toHaveLength(2);
			expect(lists[0].items.map((i: any) => i.type)).toEqual(['trail', 'trail', 'map', 'activity']);
			expect(lists[1].items).toHaveLength(1);
			expect(lists[1].items[0].trail.id).toBe(lists[0].items[0].trail.id);
			const completed = await atAll(fake, 'completed');
			expect(completed).toHaveLength(2);
			expect(completed[0].completedAt).toMatch(/^\d{4}-\d\d-\d\d$/);
			expect(completed.some((c) => c.rating !== null && c.review !== null)).toBe(true);

			const trails: any[] = [
				...lists.flatMap((l) =>
					l.items.filter((i: any) => i.type === 'trail').map((i: any) => i.trail)
				),
				...completed.map((c) => c.trail)
			];
			for (const t of trails) {
				expect(t.user).toBeNull();
				expect(t.description).toContain(SENTINELS.trailDescription);
				expect(t.polyline.pointsData.startsWith(SENTINELS.trailPolyline)).toBe(true);
				const decoded = decodePolyline(t.polyline.pointsData);
				expect(decoded.length).toBeGreaterThanOrEqual(4);
				expect(decoded.length).toBeLessThanOrEqual(10);
				const flat = decoded.slice(0, 2).flatMap(([lat, lon]) => [lat.toFixed(5), lon.toFixed(5)]);
				expect(flat).toEqual(trailCoordinatesP5);
				const loc = JSON.stringify(t.location);
				for (const c of trailCoordinatesP5) expect(loc).not.toContain(c);
			}
			const distinct = [...new Map(trails.map((t) => [t.id, t])).values()];
			expect(distinct).toHaveLength(3);
			expect(fake.expected('alltrails').references).toEqual(
				distinct.map((t) => ({
					name: t.name,
					url: `${fake.origin('alltrails')}/trail/${t.slug}`,
					sourceId: String(t.id),
					coordinate: [t.location.longitude, t.location.latitude]
				}))
			);
			const page = await site(fake, 'alltrails', `/trail/${distinct[0].slug}`);
			expect(page.status).toBe(200);
		});

		it('details decode to the same points as the native GPX', async () => {
			const expected = fake.expected('alltrails');
			let multiSegment = 0;
			const check = async (kind: 'track' | 'route', resource: string, id: string) => {
				const gpx = await site(fake, 'alltrails', `${base}/${resource}/${id}/export?format=gpx`);
				expect(gpx.status).toBe(200);
				expect(gpx.headers['content-type']).toBe('application/gpx+xml');
				expect(gpx.body.equals(fake.nativeGpx('alltrails', kind, id))).toBe(true);
				expect(gpx.body.equals(fake.nativeGpx('alltrails', kind, Number(id)))).toBe(true);
				expect(gpx.text).toContain('<trk>');
				for (const s of sentinelStrings()) expect(gpx.text).not.toContain(s);
				const detail = (await site(fake, 'alltrails', `${base}/${resource}/${id}`)).json();
				if (detail.segments.length > 1) multiSegment++;
				const pts = [...gpx.text.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)];
				const decoded: [number, number][] = [];
				for (const seg of detail.segments) {
					const points = decodePolyline(seg.polyline.pointsData);
					if (seg.polyline.elevationData)
						expect(seg.polyline.elevationData).toHaveLength(points.length);
					if (seg.polyline.timeData) expect(seg.polyline.timeData).toHaveLength(points.length);
					if (kind === 'route') expect(seg.polyline.timeData).toBeNull();
					else expect(seg.polyline.timeData).not.toBeNull();
					decoded.push(...points);
				}
				expect(decoded.length).toBeGreaterThanOrEqual(24);
				expect(pts).toHaveLength(decoded.length);
				pts.forEach((m, i) => {
					expect(Number(m[1])).toBe(decoded[i]![0]);
					expect(Number(m[2])).toBe(decoded[i]![1]);
				});
			};
			for (const id of expected.ids.tracks) await check('track', 'activities', id);
			for (const id of expected.ids.routes) await check('route', 'maps', id);
			expect(multiSegment).toBeGreaterThanOrEqual(1);
			expect(
				(await site(fake, 'alltrails', `${base}/activities/${expected.ids.tracks[0]}/export`))
					.status
			).toBe(400);
		});
	});

	describe('polyline + sentinels', () => {
		it('encodes the canonical Google example', () => {
			const pts: [number, number][] = [
				[38.5, -120.2],
				[40.7, -120.95],
				[43.252, -126.453]
			];
			expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
			expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(pts);
		});

		it('derives trailPolyline and trailCoordinatesP5 from trailCoordinates', () => {
			expect(trailCoordinatesP5).toEqual(['37.74619', '-119.53329', '37.74881', '-119.53046']);
			expect(SENTINELS.trailCoordinatesP5).toEqual(trailCoordinatesP5);
			const c = SENTINELS.trailCoordinates.map(Number);
			expect(SENTINELS.trailPolyline).toBe(
				encodePolyline([
					[c[0]!, c[1]!],
					[c[2]!, c[3]!]
				])
			);
			// Must be findable in raw JSON bytes: nothing JSON would escape.
			expect(SENTINELS.trailPolyline).not.toMatch(/[\\"]/);
		});

		it('sentinel coordinates and secrets never leak into owned-object fields', () => {
			const strip = (value: unknown): unknown => {
				if (Array.isArray(value)) return value.map(strip);
				if (value && typeof value === 'object') {
					const out: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(value)) {
						// The one intentional plant on own objects.
						if (k === 'user_email') continue;
						out[k] = strip(v);
					}
					return out;
				}
				return value;
			};
			const g = fake.objects('gaiagps');
			const mine = (o: any) => o.user_id === 'gu-1001';
			const a = fake.objects('alltrails');
			const mineAt = (o: any) => o.user.id === 7001;
			const owned = [
				...g.tracks.filter((t) => mine(t.summary)).flatMap((t) => [t.summary, t.detail]),
				...g.routes.filter((t) => mine(t.summary)).flatMap((t) => [t.summary, t.detail]),
				...g.waypoints.filter(mine),
				...g.areas.filter(mine),
				...g.photos.filter(mine),
				...g.folders.filter(mine).map((f) => ({ ...f, saved_hikes: [] })),
				...(g.folders.flatMap((f) => f.saved_hikes) as any[]).map((h) => ({
					trailhead: h.trailhead,
					user_notes: h.user_notes
				})),
				...a.activities.filter((t) => mineAt(t.summary)).flatMap((t) => [t.summary, t.detail]),
				...a.maps.filter((t) => mineAt(t.summary)).flatMap((t) => [t.summary, t.detail]),
				...a.photos.filter(mineAt),
				...a.lists.map((l) => ({ ...l, items: [] })),
				...a.completed.map((c) => ({ ...c, trail: { location: (c.trail as any).location } }))
			];
			const text = JSON.stringify(strip(owned));
			// Decoded polylines too, since the encoded form hides the digits.
			const decoded = [...a.activities, ...a.maps]
				.flatMap((l) =>
					(l.detail.segments as any[]).map((s) => decodePolyline(s.polyline.pointsData))
				)
				.flat()
				.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`)
				.join(' ');
			for (const s of sentinelStrings()) {
				expect(text).not.toContain(s);
				expect(decoded).not.toContain(s);
			}
		});

		it('objects() mirrors what the API serves', async () => {
			const g = fake.objects('gaiagps');
			expect(g.tracks.map((t) => t.summary)).toEqual(await gaiaAll(fake, 'track'));
			expect(g.folders).toEqual(await gaiaAll(fake, 'folder'));
			expect(g.photos).toEqual(await gaiaAll(fake, 'photo'));
			const detail = (await site(fake, 'gaiagps', '/api/v3/track/gt-3001/')).json();
			expect(g.tracks.find((t) => t.summary.id === 'gt-3001')?.detail).toEqual(detail);
			const a = fake.objects('alltrails');
			expect(a.maps.map((m) => m.summary)).toEqual(await atAll(fake, 'maps'));
			expect(a.lists).toEqual(await atAll(fake, 'lists'));
		});

		it('is deterministic across server instances (modulo the port)', async () => {
			const other = await startFakeSource({ port: 0, dataset: 'small' });
			try {
				const norm = (f: FakeSource, p: Platform) =>
					JSON.stringify(f.objects(p)).replaceAll(`:${f.port}`, ':PORT');
				expect(norm(other, 'gaiagps')).toBe(norm(fake, 'gaiagps'));
				expect(norm(other, 'alltrails')).toBe(norm(fake, 'alltrails'));
				expect(
					other
						.nativeGpx('gaiagps', 'track', 'gt-3006')
						.equals(fake.nativeGpx('gaiagps', 'track', 'gt-3006'))
				).toBe(true);
			} finally {
				await other.close();
			}
		});
	});

	describe('faults', () => {
		it('status with skip/count and Retry-After; setFaults resets counters', async () => {
			const faults = [
				{
					platform: 'gaiagps' as const,
					match: '^/api/v3/track/\\?',
					skip: 1,
					count: 2,
					action: { kind: 'status' as const, status: 429, retryAfter: 2 }
				}
			];
			fake.setFaults(faults);
			const statuses: number[] = [];
			for (let i = 0; i < 5; i++) {
				const res = await site(fake, 'gaiagps', '/api/v3/track/?page=1');
				statuses.push(res.status);
				if (res.status === 429) expect(res.headers['retry-after']).toBe('2');
			}
			expect(statuses).toEqual([200, 429, 429, 200, 200]);
			// Non-matching path and other platform are untouched.
			expect((await site(fake, 'gaiagps', '/api/v3/route/')).status).toBe(200);
			fake.setFaults(faults);
			expect((await site(fake, 'gaiagps', '/api/v3/track/?page=1')).status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/v3/track/?page=1')).status).toBe(429);
		});

		it('first open fault wins; platform filter applies', async () => {
			fake.setFaults([
				{ platform: 'alltrails', match: '/me', action: { kind: 'status', status: 500 } },
				{ match: '/me', count: 1, action: { kind: 'status', status: 403, body: 'nope' } },
				{ match: '/me', action: { kind: 'status', status: 404 } }
			]);
			const first = await site(fake, 'gaiagps', '/api/v3/me/');
			expect(first.status).toBe(403);
			expect(first.text).toBe('nope');
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(404);
			expect((await site(fake, 'alltrails', '/api/alltrails/v3/me')).status).toBe(500);
		});

		it('403 on GPX endpoints leaves JSON details reachable', async () => {
			fake.setFaults([{ match: '\\.gpx$|/export\\?', action: { kind: 'status', status: 403 } }]);
			expect((await site(fake, 'gaiagps', '/api/v3/track/gt-3001.gpx')).status).toBe(403);
			expect((await site(fake, 'gaiagps', '/api/v3/track/gt-3001/')).status).toBe(200);
			expect(
				(await site(fake, 'alltrails', '/api/alltrails/v3/activities/810001/export?format=gpx'))
					.status
			).toBe(403);
		});

		it('challenge answers 200 text/html', async () => {
			fake.setFaults([{ match: '/api/', count: 1, action: { kind: 'challenge' } }]);
			const res = await site(fake, 'gaiagps', '/api/v3/waypoint/');
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toMatch(/^text\/html/);
			expect(res.text).toContain('Checking your browser');
			expect((await site(fake, 'gaiagps', '/api/v3/waypoint/')).json().count).toBe(5);
		});

		it('drop destroys the socket and logs status 0', async () => {
			fake.setFaults([{ match: '/api/v3/area/', count: 1, action: { kind: 'drop' } }]);
			await expect(site(fake, 'gaiagps', '/api/v3/area/')).rejects.toThrow();
			await sleep(20);
			const entry = fake.log().find((e) => e.path === '/api/v3/area/');
			expect(entry?.status).toBe(0);
			expect(entry!.end).toBeGreaterThanOrEqual(entry!.start);
			expect((await site(fake, 'gaiagps', '/api/v3/area/')).status).toBe(200);
		});

		it('expire-session answers unauthenticated until login()', async () => {
			fake.setFaults([{ match: '/api/', skip: 1, count: 1, action: { kind: 'expire-session' } }]);
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(401);
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(401);
			// Only that platform's session died.
			expect((await site(fake, 'alltrails', '/api/alltrails/v3/me')).status).toBe(200);
			fake.login('gaiagps');
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(200);

			fake.setFaults([
				{ platform: 'alltrails', match: '/api/', count: 1, action: { kind: 'expire-session' } }
			]);
			const res = await site(fake, 'alltrails', '/api/alltrails/v3/me');
			expect(res.status).toBe(302);
			expect((await site(fake, 'alltrails', '/')).text).toContain('href="/login"');
			await site(fake, 'alltrails', '/login', { method: 'POST', body: '' });
			expect((await site(fake, 'alltrails', '/api/alltrails/v3/me')).status).toBe(200);
		});

		it('schema-drift renames the listing key', async () => {
			fake.setFaults([{ match: '/api/', action: { kind: 'schema-drift' } }]);
			const g = (await site(fake, 'gaiagps', '/api/v3/track/')).json();
			expect(g.results).toBeUndefined();
			expect(g.data).toHaveLength(3);
			expect(g.count).toBe(7);
			const a = (await site(fake, 'alltrails', '/api/alltrails/v3/users/7001/lists')).json();
			expect(a.items).toBeUndefined();
			expect(a.entries).toHaveLength(2);
			// Nested `items` inside list objects are untouched.
			expect(a.entries[0].items).toHaveLength(4);
			// Not a listing: served normally.
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).json().id).toBe('gu-1001');
		});

		it('delay responds normally afterwards and survives a client abort', async () => {
			fake.setFaults([{ match: '/api/v3/me/', action: { kind: 'delay', ms: 120 } }]);
			const t0 = performance.now();
			const res = await site(fake, 'gaiagps', '/api/v3/me/');
			expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
			expect(res.json().id).toBe('gu-1001');

			fake.resetLog();
			await new Promise<void>((resolve) => {
				const req = httpRequest({
					host: '127.0.0.1',
					port: fake.port,
					path: '/api/v3/me/',
					headers: { Host: `gaia.localhost:${fake.port}`, Cookie: cookieOf(fake, 'gaiagps') },
					agent: false
				});
				req.on('error', () => resolve());
				req.end();
				setTimeout(() => req.destroy(), 30);
			});
			await sleep(150);
			const log = fake.log();
			expect(log).toHaveLength(1);
			expect(log[0]!.status).toBe(0);
			expect(log[0]!.end - log[0]!.start).toBeLessThan(110);
			fake.setFaults([]);
			expect((await site(fake, 'gaiagps', '/api/v3/me/')).status).toBe(200);
		});
	});

	describe('log + stats', () => {
		it('classifies lanes and records timings', async () => {
			fake.resetLog();
			await site(fake, 'gaiagps', '/api/v3/me/');
			await site(fake, 'gaiagps', '/robots.txt');
			await http(fake, 'cdn.gaia.localhost', '/photos/gp-7001/full');
			await site(fake, 'alltrails', '/api/alltrails/v3/me', { cookie: false });
			const log = fake.log();
			expect(log.map((e) => [e.platform, e.lane, e.method, e.path, e.status])).toEqual([
				['gaiagps', 'api', 'GET', '/api/v3/me/', 200],
				['gaiagps', 'page', 'GET', '/robots.txt', 200],
				['gaiagps', 'asset', 'GET', '/photos/gp-7001/full', 200],
				['alltrails', 'api', 'GET', '/api/alltrails/v3/me', 302]
			]);
			for (const e of log) expect(e.end).toBeGreaterThanOrEqual(e.start);
			expect(fake.stats('gaiagps')).toMatchObject({
				apiRequests: 1,
				assetRequests: 1,
				peakApiConcurrency: 1,
				peakAssetConcurrency: 1,
				minApiGapMs: Infinity
			});
			fake.resetLog();
			expect(fake.log()).toEqual([]);
			expect(fake.stats('gaiagps').apiRequests).toBe(0);
		});

		it('measures peak concurrency and the minimum start gap', async () => {
			fake.setFaults([{ match: '/api/', action: { kind: 'delay', ms: 80 } }]);
			await Promise.all([
				site(fake, 'gaiagps', '/api/v3/me/'),
				site(fake, 'gaiagps', '/api/v3/track/'),
				site(fake, 'gaiagps', '/api/v3/route/'),
				site(fake, 'alltrails', '/api/alltrails/v3/me')
			]);
			const parallel = fake.stats('gaiagps');
			expect(parallel.apiRequests).toBe(3);
			expect(parallel.peakApiConcurrency).toBe(3);
			expect(parallel.minApiGapMs).toBeLessThan(60);
			expect(fake.stats('alltrails').peakApiConcurrency).toBe(1);

			fake.setFaults([]);
			fake.resetLog();
			for (let i = 0; i < 3; i++) {
				await site(fake, 'gaiagps', '/api/v3/me/');
				await sleep(50);
			}
			const serial = fake.stats('gaiagps');
			expect(serial.peakApiConcurrency).toBe(1);
			expect(serial.minApiGapMs).toBeGreaterThanOrEqual(45);
			expect(serial.minApiGapMs).toBeLessThan(500);
		});
	});
});

describe('fake-source (large dataset)', () => {
	const PHOTOS = 1100;
	const PHOTO_BYTES = 5_000_000;
	let fake: FakeSource;

	beforeAll(async () => {
		fake = await startFakeSource({
			port: 0,
			dataset: { kind: 'large', photos: PHOTOS, photoBytes: PHOTO_BYTES }
		});
	});
	afterAll(async () => {
		await fake.close();
	});

	it('expected() describes a photo-heavy Gaia account and an empty AllTrails one', async () => {
		const expected = fake.expected('gaiagps');
		expect(expected.counts).toEqual({
			tracks: 2,
			routes: 0,
			waypoints: 0,
			areas: 0,
			collections: 0,
			photos: PHOTOS
		});
		expect(expected.ids.photos).toHaveLength(PHOTOS);
		expect(new Set(expected.ids.photos).size).toBe(PHOTOS);
		expect(expected.references).toEqual([]);
		expect(PHOTOS * PHOTO_BYTES).toBeGreaterThanOrEqual(5e9);
		expect(fake.expected('alltrails').counts).toEqual({
			tracks: 0,
			routes: 0,
			waypoints: 0,
			areas: 0,
			collections: 0,
			photos: 0
		});
		expect(
			(await site(fake, 'alltrails', '/api/alltrails/v3/users/7001/activities')).json()
		).toEqual({
			items: [],
			meta: { nextCursor: null }
		});
		expect((await site(fake, 'gaiagps', '/api/v3/folder/')).json().count).toBe(0);
	});

	it('pages photos lazily with maxPageSize 100', async () => {
		const p1 = (await site(fake, 'gaiagps', '/api/v3/photo/?page=1&page_size=500')).json();
		expect(p1.count).toBe(PHOTOS);
		expect(p1.results).toHaveLength(100);
		expect(p1.next).toContain('page=2&page_size=100');
		const last = (await site(fake, 'gaiagps', '/api/v3/photo/?page=11&page_size=100')).json();
		expect(last.results).toHaveLength(100);
		expect(last.next).toBeNull();
		const expected = fake.expected('gaiagps');
		expect(p1.results.map((p: any) => p.id)).toEqual(expected.ids.photos.slice(0, 100));
		expect(last.results.at(-1).id).toBe(expected.ids.photos.at(-1));
		const tracks = (await site(fake, 'gaiagps', '/api/v3/track/')).json();
		expect(tracks.results.map((t: any) => t.id)).toEqual(expected.ids.tracks);
	});

	it('streams a full-size photo with the right Content-Length and flat memory', async () => {
		const page = (await site(fake, 'gaiagps', '/api/v3/photo/?page=3')).json();
		const urls: string[] = page.results.slice(0, 6).map((p: any) => p.fullsize_url);
		const first = toPath(urls[0]!);
		const small = await http(fake, first.host, first.path);
		expect(small.body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
		expect(small.body.length).toBe(PHOTO_BYTES);
		const second = await http(fake, toPath(urls[1]!).host, toPath(urls[1]!).path);
		expect(second.body.subarray(0, 64).equals(small.body.subarray(0, 64))).toBe(false);
		expect(second.body.equals(small.body)).toBe(false);

		globalThis.gc?.();
		const before = process.memoryUsage();
		let total = 0;
		for (let round = 0; round < 4; round++) {
			for (const url of urls) {
				const { host, path } = toPath(url);
				const res = await http(fake, host, path, { discard: true });
				expect(res.status).toBe(200);
				expect(res.headers['content-type']).toBe('image/jpeg');
				expect(Number(res.headers['content-length'])).toBe(PHOTO_BYTES);
				expect(res.length).toBe(PHOTO_BYTES);
				total += res.length;
			}
		}
		expect(total).toBe(24 * PHOTO_BYTES);
		const after = process.memoryUsage();
		// 120 MB went over the wire; per-photo buffers would show up here.
		expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(32 * 1024 * 1024);
	});

	it('survives a client that disconnects mid-stream', async () => {
		const id = fake.expected('gaiagps').ids.photos[5]!;
		fake.resetLog();
		await new Promise<void>((resolve) => {
			const req = httpRequest(
				{
					host: '127.0.0.1',
					port: fake.port,
					path: `/photos/${id}/full`,
					headers: { Host: `cdn.gaia.localhost:${fake.port}` },
					agent: false
				},
				(res) => {
					res.once('data', () => {
						req.destroy();
						resolve();
					});
					res.on('error', () => {});
				}
			);
			req.on('error', () => {});
			req.end();
		});
		await sleep(100);
		const log = fake.log();
		expect(log).toHaveLength(1);
		expect(log[0]!.lane).toBe('asset');
		expect(log[0]!.status).toBe(0);
		const ok = await http(fake, 'cdn.gaia.localhost', `/photos/${id}/full`, { discard: true });
		expect(ok.length).toBe(PHOTO_BYTES);
	});
});

function sentinelStrings(): string[] {
	return [
		SENTINELS.sessionCookie.gaiagps,
		SENTINELS.sessionCookie.alltrails,
		SENTINELS.csrfToken,
		SENTINELS.email,
		SENTINELS.otherUserName,
		SENTINELS.otherUserEmail,
		SENTINELS.trailDescription,
		SENTINELS.otherUserDescription,
		SENTINELS.trailPolyline,
		...SENTINELS.trailCoordinates,
		...trailCoordinatesP5
	];
}
