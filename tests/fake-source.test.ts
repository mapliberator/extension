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
	/** Extra request headers. `site()` adds the AllTrails app key unless this is given. */
	headers?: Record<string, string>;
}

/** The fake site's app key, restated here on purpose. */
const AT_KEY = 'fakeatkey0123456789abcdef0123456';

const HOSTS: Record<Platform, string> = {
	gaiagps: 'gaia.localhost',
	alltrails: 'alltrails.localhost',
	strava: 'strava.localhost'
};

/** node:http to 127.0.0.1 with an explicit Host header (fetch cannot set Host). */
function http(
	fake: FakeSource,
	host: string,
	path: string,
	opts: HttpOptions = {}
): Promise<HttpResult & { length: number }> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { ...opts.headers, Host: `${host}:${fake.port}` };
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
		headers: platform === 'alltrails' ? { 'X-AT-KEY': AT_KEY } : {},
		...opts,
		cookie: opts.cookie === false ? false : (opts.cookie ?? cookieOf(fake, platform))
	});
}

function toPath(url: string): { host: string; path: string } {
	const u = new URL(url);
	return { host: u.hostname, path: u.pathname + u.search };
}

/** Gaia listings are one bare array. */
async function gaiaAll(fake: FakeSource, type: string): Promise<any[]> {
	return (await site(fake, 'gaiagps', `/api/objects/${type}/`)).json();
}

/** AllTrails listings: `{ <key>: [...], pageInfo }`, paged with `after`. */
async function atAll(fake: FakeSource, resource: string, key: string, limit = 50): Promise<any[]> {
	const out: any[] = [];
	let cursor: string | null = null;
	do {
		const separator = resource.includes('?') ? '&' : '?';
		const after: string = cursor ? `&after=${encodeURIComponent(cursor)}` : '';
		const page: any = (
			await site(
				fake,
				'alltrails',
				`/api/alltrails/users/7001/${resource}${separator}limit=${limit}${after}`
			)
		).json();
		out.push(...page[key]);
		cursor = page.pageInfo.hasNextPage ? page.pageInfo.nextCursor : null;
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
		fake.login('strava');
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
		expect(fake.origin('strava')).toBe(`http://strava.localhost:${fake.port}`);
		expect(fake.assetOrigin('strava')).toBe(`http://cdn.strava.localhost:${fake.port}`);
		expect(fake.sessionCookie('strava').domain).toBe('strava.localhost');
	});

	it('routes by Host and sends no CORS headers', async () => {
		const unknown = await http(fake, 'example.com', '/');
		expect(unknown.status).toBe(404);
		const me = await site(fake, 'gaiagps', '/api/v3/user/');
		expect(me.status).toBe(200);
		expect(Object.keys(me.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
		// AllTrails paths do not exist on the Gaia host and vice versa.
		expect((await site(fake, 'gaiagps', '/api/alltrails/me')).status).toBe(404);
		expect((await site(fake, 'alltrails', '/api/v3/user/')).status).toBe(404);
	});

	describe('sessions', () => {
		it('Gaia answers a bare 403 without a valid, active session', async () => {
			const none = await site(fake, 'gaiagps', '/api/objects/track/', { cookie: false });
			expect(none.status).toBe(403);
			expect(none.headers['content-type']).toContain('text/html');
			expect(none.body).toHaveLength(0);
			const wrong = await site(fake, 'gaiagps', '/api/objects/track/', {
				cookie: 'fs_session=nope'
			});
			expect(wrong.status).toBe(403);
			// The other platform's cookie is not valid here.
			const cross = await site(fake, 'gaiagps', '/api/objects/track/', {
				cookie: cookieOf(fake, 'alltrails')
			});
			expect(cross.status).toBe(403);

			fake.logout('gaiagps');
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(403);
			expect((await site(fake, 'alltrails', '/api/alltrails/me')).status).toBe(200);
			fake.login('gaiagps');
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(200);
		});

		it('AllTrails redirects to /login, which is a 200 HTML page', async () => {
			const res = await site(fake, 'alltrails', '/api/alltrails/me', { cookie: false });
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
			expect((await site(fake, 'alltrails', '/api/alltrails/me')).status).toBe(200);
		});

		it('serves the home page and robots.txt', async () => {
			for (const platform of ['gaiagps', 'alltrails', 'strava'] as Platform[]) {
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
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(403);
			await http(fake, 'gaia.localhost', '/__control/login?platform=gaiagps', { method: 'POST' });
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(200);

			const faults = await http(fake, 'localhost', '/__control/faults', {
				method: 'POST',
				body: JSON.stringify([{ match: '/user/', action: { kind: 'status', status: 500 } }])
			});
			expect(faults.status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/v3/user/')).status).toBe(500);

			const stats = (await http(fake, 'localhost', '/__control/stats?platform=gaiagps')).json();
			expect(stats.apiRequests).toBe(3);
			expect(fake.log().every((e) => !e.path.startsWith('/__control/'))).toBe(true);
			expect(fake.log()).toHaveLength(3);
		});
	});

	describe('Gaia shape', () => {
		it('listings are bare, unpaginated arrays that include soft-deleted objects', async () => {
			const res = await site(fake, 'gaiagps', '/api/objects/track/');
			expect(res.status).toBe(200);
			const tracks = res.json();
			expect(Array.isArray(tracks)).toBe(true);
			expect(tracks).toHaveLength(8);
			expect(tracks.filter((t: any) => t.deleted)).toHaveLength(1);
			// Query parameters change nothing: there is no pagination to ask for.
			expect(
				(await site(fake, 'gaiagps', '/api/objects/track/?page=2&page_size=3')).json()
			).toEqual(tracks);
			// The invented /api/v3 object paths are gone.
			expect((await site(fake, 'gaiagps', '/api/v3/track/?page=1')).status).toBe(404);
			expect((await site(fake, 'gaiagps', '/api/v3/me')).status).toBe(404);
		});

		it('the account endpoint carries the e-mail and a secret, and answers anonymously too', async () => {
			const me = (await site(fake, 'gaiagps', '/api/v3/user/')).json();
			expect(me).toMatchObject({
				id: 1001,
				display_name: 'Test H.',
				email: SENTINELS.email,
				is_authenticated: true
			});
			expect(JSON.stringify(me.didomi_auth)).toContain(SENTINELS.csrfToken);
			const anonymous = await site(fake, 'gaiagps', '/api/v3/user/', { cookie: false });
			expect(anonymous.status).toBe(200);
			expect(anonymous.json()).toEqual({ id: null, display_name: '', is_authenticated: false });
		});

		it('listings match expected() for owned, undeleted objects and never say who owns what', async () => {
			const expected = fake.expected('gaiagps');
			expect(expected.account).toEqual({ id: '1001', displayName: 'Test H.' });
			expect(expected.counts).toEqual({
				tracks: 6,
				routes: 4,
				waypoints: 5,
				areas: 2,
				collections: 4,
				photos: 4
			});
			// Another user's track filed in one of my folders is the one reference to expect.
			expect(expected.references).toEqual([
				{
					name: 'Shared ridge run',
					url: `${fake.origin('gaiagps')}/datasummary/track/gt-9001/`,
					sourceId: 'gt-9001',
					coordinate: [expect.any(Number), expect.any(Number)]
				}
			]);
			const listed: Record<string, number> = { track: 8, route: 5, waypoint: 6, area: 2, photo: 5 };
			const foreign = new Set(['gt-9001', 'gr-9002']);
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
				const own = all.filter((o) => !o.deleted && !foreign.has(o.id));
				expect(own.map((o) => o.id)).toEqual(expected.ids[key[type]]);
				for (const o of all) {
					expect(o.time_created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
					expect(o.last_updated_on_server).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/);
					for (const hidden of ['user_id', 'user_email', 'username', 'created_by']) {
						expect(hidden in o).toBe(false);
					}
					if (foreign.has(o.id)) expect(o.notes).toBe(SENTINELS.otherUserDescription);
				}
			}
			const [waypoint] = await gaiaAll(fake, 'waypoint');
			expect(waypoint.latitude).toEqual([expect.any(Number)]);
			expect(waypoint.longitude).toEqual([expect.any(Number)]);
		});

		it('details are GeoJSON and name the owner', async () => {
			const track = (await site(fake, 'gaiagps', '/api/objects/track/gt-3001/')).json();
			expect(track.type).toBe('FeatureCollection');
			expect(track.features).toHaveLength(1);
			expect(track.features[0].properties).toMatchObject({
				user_id: 1001,
				user_email: SENTINELS.email,
				writable: true
			});
			const theirs = (await site(fake, 'gaiagps', '/api/objects/track/gt-9001/')).json();
			expect(theirs.features[0].properties).toMatchObject({
				user_id: 2002,
				user_displayname: SENTINELS.otherUserName,
				user_email: SENTINELS.otherUserEmail,
				writable: false
			});
			const waypoint = (await site(fake, 'gaiagps', '/api/objects/waypoint/gw-5001/')).json();
			expect(waypoint.type).toBe('Feature');
			expect(waypoint.geometry.coordinates).toHaveLength(2);
			expect(waypoint.properties.elevation).toBe(3652.4);
			const folder = (await site(fake, 'gaiagps', '/api/objects/folder/gf-8001/')).json();
			// `name` in the detail, `title` in the listing.
			expect(folder.properties.name).toBe('Sierra 2024');
			expect((await site(fake, 'gaiagps', '/api/objects/track/nope/')).status).toBe(404);
		});

		it('folders: nesting, many-to-many membership, deleted and shared folders', async () => {
			const folders = await gaiaAll(fake, 'folder');
			expect(folders).toHaveLength(5);
			expect(folders.filter((f) => f.deleted)).toHaveLength(1);
			const own = folders.filter((f) => f.access === 'owner' && !f.deleted);
			expect(own).toHaveLength(3);
			expect(own.filter((f) => f.parent !== null)).toHaveLength(1);
			const child = own.find((f) => f.parent !== null);
			expect(own.find((f) => f.id === child.parent).children).toEqual([child.id]);
			const memberships = own.flatMap((f) => f.tracks as string[]);
			expect(new Set(memberships).size).toBeLessThan(memberships.length);
			for (const f of own) expect(f).toMatchObject({ is_shared: false, writable: true });

			const shared = folders.filter((f) => f.access !== 'owner');
			expect(shared).toHaveLength(1);
			expect(shared[0]).toMatchObject({ is_shared: true, access: 'read', writable: false });
			expect(shared[0].notes).toBe(SENTINELS.otherUserDescription);
			// Another user's track sits in one of my folders as well as in theirs.
			expect(own.some((f) => f.tracks.includes('gt-9001'))).toBe(true);
			expect(shared[0].tracks).toContain('gt-9001');
		});

		it('exercises the filename sanitizer', async () => {
			const tracks = (await gaiaAll(fake, 'track')).filter((t) => t.id !== 'gt-9001');
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
				const a = await site(fake, 'gaiagps', `/api/objects/track/${id}.gpx`);
				// The real endpoint answers with or without the trailing slash.
				const b = await site(fake, 'gaiagps', `/api/objects/track/${id}.gpx/`);
				expect(a.status).toBe(200);
				expect(a.headers['content-type']).toBe('application/gpx+xml');
				expect(a.body.equals(fake.nativeGpx('gaiagps', 'track', id))).toBe(true);
				expect(a.body.equals(b.body)).toBe(true);
				expect(a.body.subarray(0, 5).toString()).toBe('<?xml');
				expect(a.text).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
				expect(a.text).toContain('creator="GaiaGPS"');
				expect(a.text).toContain('<gaia:color>');
				expect(a.text.trimEnd().endsWith('</gpx>')).toBe(true);
				for (const s of sentinelStrings()) expect(a.text).not.toContain(s);
				// eslint-disable-next-line no-control-regex
				if (/<name>[^<]*[^\x00-\x7f]/.test(a.text)) nonAscii++;

				const detail = (await site(fake, 'gaiagps', `/api/objects/track/${id}/`)).json();
				const geometry = detail.features[0].geometry;
				expect(geometry.type).toBe('MultiLineString');
				const coords: number[][][] = geometry.coordinates;
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
				const gpx = await site(fake, 'gaiagps', `/api/objects/route/${id}.gpx`);
				expect(gpx.body.equals(fake.nativeGpx('gaiagps', 'route', id))).toBe(true);
				expect(gpx.text).toContain('<rte>');
				expect(gpx.text).not.toContain('<trk>');
				const detail = (await site(fake, 'gaiagps', `/api/objects/route/${id}/`)).json();
				const flat: number[][] = detail.features[0].geometry.coordinates.flat();
				// Four slots like a track, with a zero where the time would be.
				expect(flat[0]).toHaveLength(4);
				expect(flat[0]![3]).toBe(0);
				expect((gpx.text.match(/<rtept /g) ?? []).length).toBe(flat.length);
			}
			expect(() => fake.nativeGpx('gaiagps', 'track', 'nope')).toThrow();
		});

		it('photos: session-free redirect to a signed photo-host URL, content types, stable bytes', async () => {
			const photos = await gaiaAll(fake, 'photo');
			const types = new Set<string>();
			const bodies: Buffer[] = [];
			fake.resetLog();
			for (const p of photos) {
				expect(p.scaled).toBe(`${fake.origin('gaiagps')}/api/objects/photo/${p.id}/image/1000/`);
				expect(typeof p.waypoint_id).toBe('string');
				// No cookie: the real endpoint redirects anonymous requests too.
				const hop = await site(fake, 'gaiagps', `/api/objects/photo/${p.id}/image/full/`, {
					cookie: false
				});
				expect(hop.status).toBe(302);
				const location = String(hop.headers.location);
				expect(location.startsWith(`${fake.assetOrigin('gaiagps')}/photos/${p.id}/full?`)).toBe(
					true
				);
				expect(location).toContain(`Signature=${SENTINELS.photoSignature}`);
				const { host, path } = toPath(location);
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
			expect((await http(fake, 'cdn.gaia.localhost', '/photos/nope/full')).status).toBe(404);
			// Redirect hops are asset traffic, not API calls: they are not paced like the API.
			const stats = fake.stats('gaiagps');
			expect(stats.apiRequests).toBe(0);
			expect(stats.assetRequests).toBe(photos.length * 3 + 1);
		});
	});

	describe('AllTrails shape', () => {
		const base = '/api/alltrails';

		it('every API call needs the app key', async () => {
			const none = await site(fake, 'alltrails', `${base}/me`, { headers: {} });
			expect(none.status).toBe(400);
			expect(none.json().errors[0].code).toBe('missing_key');
			const wrong = await site(fake, 'alltrails', `${base}/me`, {
				headers: { 'X-AT-KEY': 'nope' }
			});
			expect(wrong.json().errors[0].code).toBe('invalid_key');
			const unknown = await site(fake, 'alltrails', `${base}/users/7001/stats`);
			expect(unknown.status).toBe(400);
			expect(unknown.json()).toMatchObject({
				errors: [{ code: 'method_not_found', target: null, debug: null }],
				meta: { status: 'error' }
			});
		});

		it('turns away API calls that name /robots.txt as their referrer, like the real bot protection', async () => {
			const blocked = await site(fake, 'alltrails', `${base}/me`, {
				headers: { 'X-AT-KEY': AT_KEY, Referer: `${fake.origin('alltrails')}/robots.txt` }
			});
			expect(blocked.status).toBe(403);
			expect(Object.keys(blocked.json())).toEqual(['url']);
			const fine = await site(fake, 'alltrails', `${base}/me`, {
				headers: { 'X-AT-KEY': AT_KEY, Referer: `${fake.origin('alltrails')}/` }
			});
			expect(fine.status).toBe(200);
		});

		it('me: an envelope, the e-mail and a secret, and list counters that cannot be trusted', async () => {
			const me = (await site(fake, 'alltrails', `${base}/me`)).json();
			expect(me.users).toHaveLength(1);
			expect(me.users[0]).toMatchObject({
				id: 7001,
				email: SENTINELS.email,
				referralCode: SENTINELS.csrfToken,
				tracks: 4,
				maps: 3,
				photos: 3,
				lists: 0
			});
			expect((await site(fake, 'alltrails', `${base}/users/1/maps`)).status).toBe(403);
		});

		it('clamps limit and pages with after=; other cursor names are ignored', async () => {
			const path = `${base}/users/7001/maps?presentation_type=track`;
			const p1 = (await site(fake, 'alltrails', `${path}&limit=50`)).json();
			expect(p1.maps).toHaveLength(3);
			expect(p1.pageInfo).toMatchObject({ totalItemCount: 5, itemCount: 3, hasNextPage: true });
			const next = encodeURIComponent(p1.pageInfo.nextCursor);
			const p2 = (await site(fake, 'alltrails', `${path}&limit=50&after=${next}`)).json();
			expect(p2.maps).toHaveLength(2);
			expect(p2.pageInfo.hasNextPage).toBe(false);
			expect('nextCursor' in p2.pageInfo).toBe(false);
			const ignored = (await site(fake, 'alltrails', `${path}&limit=50&cursor=${next}`)).json();
			expect(ignored.maps[0].id).toBe(p1.maps[0].id);
			expect((await site(fake, 'alltrails', `${path}&after=garbage`)).status).toBe(400);
			// Without a presentation type, recordings and custom routes come mixed.
			const mixed = await atAll(fake, 'maps', 'maps');
			expect(new Set(mixed.map((m) => m.presentationType))).toEqual(new Set(['map', 'track']));
		});

		it('listings match expected() for owned objects', async () => {
			const expected = fake.expected('alltrails');
			expect(expected.account).toEqual({ id: '7001', displayName: 'Test H.' });
			expect(expected.counts).toEqual({
				tracks: 4,
				routes: 3,
				waypoints: 5,
				areas: 0,
				collections: 2,
				photos: 3
			});
			const tracks = await atAll(fake, 'maps?presentation_type=track', 'maps');
			expect(tracks).toHaveLength(5);
			const own = tracks.filter((t) => t.user.id === 7001);
			expect(own.map((t) => String(t.id))).toEqual(expected.ids.tracks);
			const other = tracks.filter((t) => t.user.id !== 7001);
			expect(other).toHaveLength(1);
			expect(other[0].user.firstName).toBe(SENTINELS.otherUserName);
			expect(other[0].description).toBe(SENTINELS.otherUserDescription);
			for (const t of tracks) {
				expect(t.presentationType).toBe('track');
				expect(t.metadata.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
				expect(typeof t.location.latitude).toBe('string');
				expect(typeof t.summaryStats.duration).toBe('number');
				// Geometry, waypoints and photo links are not in the listing.
				for (const hidden of ['tracks', 'routes', 'waypoints', 'mapPhotos']) {
					expect(hidden in t).toBe(false);
				}
			}
			const maps = await atAll(fake, 'maps?presentation_type=map', 'maps');
			expect(maps.map((m) => String(m.id))).toEqual(expected.ids.routes);
			expect(expected.ids.areas).toEqual([]);

			const waypointIds: string[] = [];
			for (const id of [...expected.ids.tracks, ...expected.ids.routes]) {
				const shallow = (await site(fake, 'alltrails', `${base}/maps/${id}`)).json().maps[0];
				expect('waypoints' in shallow).toBe(false);
				const deep = (await site(fake, 'alltrails', `${base}/maps/${id}?detail=deep`)).json();
				for (const w of deep.maps[0].waypoints) {
					waypointIds.push(String(w.id));
					expect(w.user).toHaveProperty('first_name');
					expect(typeof w.location.latitude).toBe('number');
				}
			}
			expect(waypointIds).toEqual(expected.ids.waypoints);
		});

		it('photos: no URL in the listing, attachment only in the map detail, key-but-no-session file', async () => {
			const expected = fake.expected('alltrails');
			const photos = await atAll(fake, 'photos', 'photos');
			expect(photos).toHaveLength(4);
			const own = photos.filter((p) => p.user.id === 7001);
			expect(own.map((p) => String(p.id))).toEqual(expected.ids.photos);
			for (const p of photos) {
				expect(JSON.stringify(p)).not.toMatch(/https?:\/\//);
				expect(p.photoHash).toMatch(/^[0-9a-f]{32}$/);
			}
			expect(own.filter((p) => p.trailId !== null)).toHaveLength(1);

			const track = (await site(fake, 'alltrails', `${base}/maps/810001?detail=deep`)).json()
				.maps[0];
			expect(track.photoCount).toBe(1);
			expect(track.mapPhotos).toEqual([
				expect.objectContaining({ mapId: 810001, photo: expect.objectContaining({ id: 860001 }) })
			]);

			fake.resetLog();
			const file = `${base}/v3/photos/860001/image`;
			expect(
				(await site(fake, 'alltrails', `${file}?size=original`, { cookie: false })).status
			).toBe(400);
			const hop = await site(fake, 'alltrails', `${file}?key=${AT_KEY}&size=whatever`, {
				cookie: false,
				headers: {}
			});
			expect(hop.status).toBe(302);
			const location = String(hop.headers.location);
			expect(location).toBe(`${fake.assetOrigin('alltrails')}/p/860001/full`);
			const image = await http(fake, toPath(location).host, toPath(location).path);
			expect(image.status).toBe(200);
			expect(Number(image.headers['content-length'])).toBe(image.body.length);
			// Redirect hops are asset traffic, not API calls.
			expect(fake.stats('alltrails').apiRequests).toBe(0);
		});

		it('lists carry trail ids only; the trail lookup holds the platform’s content', async () => {
			const lists = await atAll(fake, 'lists', 'lists');
			expect(lists.map((l) => l.type)).toEqual(['user-built-in', 'user-built-in', 'user-custom']);
			// Stale on purpose, like the real thing.
			for (const l of lists) expect(l.metadata.itemsCount).toBe(0);
			const items = (await site(fake, 'alltrails', `${base}/lists/${lists[0].id}/items`)).json();
			expect(items.listItems).toHaveLength(2);
			expect(Object.keys(items.listItems[0]).sort()).toEqual(
				['id', 'listId', 'metadata', 'notes', 'order', 'trailId', 'type'].sort()
			);
			expect(items.listItems[0].type).toBe('trail');
			const empty = (await site(fake, 'alltrails', `${base}/lists/${lists[1].id}/items`)).json();
			expect(empty.listItems).toEqual([]);

			const trails: any[] = [];
			for (const id of [850001, 850002, 850003]) {
				const t = (await site(fake, 'alltrails', `${base}/trails/${id}`)).json().trails[0];
				trails.push(t);
				expect(t.overview).toContain(SENTINELS.trailDescription);
				expect(t.defaultMap.polyline.pointsData.startsWith(SENTINELS.trailPolyline)).toBe(true);
				const decoded = decodePolyline(t.defaultMap.polyline.pointsData);
				const flat = decoded.slice(0, 2).flatMap(([lat, lon]) => [lat.toFixed(5), lon.toFixed(5)]);
				expect(flat).toEqual(trailCoordinatesP5);
				const loc = JSON.stringify(t.location);
				for (const c of trailCoordinatesP5) expect(loc).not.toContain(c);
				expect(t.slug.split('/')).toHaveLength(3);
			}
			expect(fake.expected('alltrails').references).toEqual(
				trails.map((t) => ({
					name: t.name,
					url: `${fake.origin('alltrails')}/trail/${t.slug}`,
					sourceId: String(t.id),
					coordinate: [t.location.longitude, t.location.latitude]
				}))
			);
			expect((await site(fake, 'alltrails', `/trail/${trails[0].slug}`)).status).toBe(200);
		});

		it('details: precision-5 polylines with indexed elevation and time series; no GPX anywhere', async () => {
			const expected = fake.expected('alltrails');
			let multiSegment = 0;
			for (const id of expected.ids.tracks) {
				const detail = (await site(fake, 'alltrails', `${base}/maps/${id}?detail=deep`)).json()
					.maps[0];
				expect(detail.routes).toBeUndefined();
				const segments = detail.tracks[0].lineTimedSegments;
				if (segments.length > 1) multiSegment++;
				for (const seg of segments) {
					const points = decodePolyline(seg.polyline.pointsData);
					expect(points.length).toBeGreaterThanOrEqual(24);
					expect(typeof seg.polyline.indexedTimeData).toBe('string');
					expect(Date.parse(seg.dateTimeStop)).toBeGreaterThan(Date.parse(seg.dateTimeStart));
				}
			}
			expect(multiSegment).toBeGreaterThanOrEqual(1);
			for (const id of expected.ids.routes) {
				const detail = (await site(fake, 'alltrails', `${base}/maps/${id}?detail=deep`)).json()
					.maps[0];
				expect(detail.tracks).toBeUndefined();
				for (const seg of detail.routes[0].lineSegments) {
					expect('indexedTimeData' in seg.polyline).toBe(false);
					expect(typeof seg.polyline.indexedElevationData).toBe('string');
				}
			}
			const gpx = await site(fake, 'alltrails', `${base}/maps/${expected.ids.tracks[0]}/export`);
			expect(gpx.json().errors[0].code).toBe('method_not_found');
			expect(() => fake.nativeGpx('alltrails', 'track', expected.ids.tracks[0]!)).toThrow();
		});
	});

	describe('Strava shape', () => {
		const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
		const get = (path: string, opts: HttpOptions = {}) =>
			site(fake, 'strava', path, { ...opts, headers: { ...XHR, ...opts.headers } });
		const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
			site(fake, 'strava', path, {
				method: 'POST',
				body: JSON.stringify(body),
				headers: { ...XHR, 'Content-Type': 'application/json', ...headers }
			});
		const mint = async (): Promise<string> =>
			(await site(fake, 'strava', '/api/next/mint-csrf-token', { method: 'POST' })).json().token;
		const query = (after = '0', extra: Record<string, unknown> = {}) => ({
			pageSize: 50,
			after,
			searchArgs: { query: '', onlyStarred: false, createdBy: 'Any', ...extra },
			resolutions: []
		});
		const routesPage = async (after = '0', extra: Record<string, unknown> = {}) =>
			post('/api/next/data/routes/my-routes', query(after, extra), {
				'x-csrf-token': await mint()
			});

		it('JSON listings need X-Requested-With; without it they answer with the HTML page', async () => {
			const page = await site(fake, 'strava', '/athlete/training_activities?page=1&per_page=20');
			expect(page.status).toBe(200);
			expect(page.headers['content-type']).toMatch(/^text\/html/);
			const listing = await get('/athlete/training_activities?page=1&per_page=20');
			expect(listing.headers['content-type']).toMatch(/^application\/json/);
			expect(Object.keys(listing.json())).toEqual(['models', 'page', 'perPage', 'total']);
			const photos = await site(fake, 'strava', '/athletes/3001/photos');
			expect(photos.headers['content-type']).toMatch(/^text\/html/);
			// The account endpoint and the streams answer either way.
			expect((await site(fake, 'strava', '/frontend/athletes/current')).json()).toHaveProperty(
				'currentAthlete.id',
				3001
			);
		});

		it('activities page with page=, per_page capped (at 20, and at the dataset page size)', async () => {
			const expected = fake.expected('strava');
			const p1 = (await get('/athlete/training_activities?page=1&per_page=500')).json();
			expect(p1).toMatchObject({ page: 1, perPage: 3, total: 5 });
			expect(p1.models).toHaveLength(3);
			const p2 = (await get('/athlete/training_activities?page=2&per_page=500')).json();
			expect(p2.models).toHaveLength(2);
			expect((await get('/athlete/training_activities?page=3')).json().models).toEqual([]);
			const all = [...p1.models, ...p2.models];
			expect(all.filter((a) => a.has_latlng).map((a) => a.id_str)).toEqual(expected.ids.tracks);
			for (const a of all) {
				expect(a.id_str).toBe(String(a.id));
				expect(a.start_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
				expect(typeof a.distance_raw).toBe('number');
				expect(a.trainer).toBe(!a.has_latlng);
			}
			expect(new Set(all.map((a) => a.visibility))).toEqual(
				new Set(['everyone', 'only_me', 'followers_only'])
			);
		});

		it('GPX exports: octet-stream, byte-identical to nativeGpx(); no GPS bounces to the dashboard', async () => {
			const expected = fake.expected('strava');
			const id = expected.ids.tracks[0]!;
			const gpx = await site(fake, 'strava', `/activities/${id}/export_gpx`);
			expect(gpx.status).toBe(200);
			expect(gpx.headers['content-type']).toBe('application/octet-stream');
			expect(gpx.body.equals(fake.nativeGpx('strava', 'track', id))).toBe(true);
			expect(gpx.text).toContain('creator="StravaGPX"');
			const indoor = await site(fake, 'strava', '/activities/11200000004/export_gpx');
			expect(indoor.status).toBe(302);
			expect(indoor.headers.location).toBe('/dashboard');
			expect((await site(fake, 'strava', '/dashboard')).status).toBe(200);

			const route = expected.ids.routes[0]!;
			const routeGpx = await site(fake, 'strava', `/routes/${route}/export_gpx`);
			expect(routeGpx.body.equals(fake.nativeGpx('strava', 'route', route))).toBe(true);
			// Planned: no per-point times.
			expect(/<trkpt[^>]*>(?:(?!<\/trkpt>)[^])*<time>/.test(routeGpx.text)).toBe(false);
		});

		it('streams: only the types asked for; times count seconds from the start', async () => {
			const id = fake.expected('strava').ids.tracks[0]!;
			const streams = (
				await get(`/activities/${id}/streams?stream_types[]=latlng&stream_types[]=time`)
			).json();
			expect(Object.keys(streams)).toEqual(['latlng', 'time']);
			expect(streams.time[0]).toBe(0);
			expect(streams.latlng).toHaveLength(streams.time.length);
			const gpx = fake.nativeGpx('strava', 'track', id).toString('utf8');
			expect(gpx).toContain(`lat="${streams.latlng[0][0].toFixed(6)}"`);
			const indoor = (
				await get('/activities/11200000004/streams?stream_types[]=latlng&stream_types[]=time')
			).json();
			expect(Object.keys(indoor)).toEqual(['time']);
		});

		it('routes: POST only, with a token minted for this session; ids are 19-digit strings', async () => {
			expect((await get('/api/next/data/routes/my-routes')).status).toBe(405);
			expect((await get('/api/next/mint-csrf-token')).status).toBe(405);
			const none = await post('/api/next/data/routes/my-routes', query());
			expect(none.status).toBe(403);
			expect(none.body).toHaveLength(0);
			const token = await mint();
			expect(token).toContain(SENTINELS.csrfToken);
			const page = await routesPage();
			expect(page.status).toBe(200);
			const { me } = page.json();
			expect(me.id).toBe('3001');
			expect(me.searchRoutes.nodes).toHaveLength(3);
			expect(me.searchRoutes.pageInfo).toMatchObject({ endCursor: '2', hasNextPage: true });
			const rest = (await routesPage('2')).json().me.searchRoutes;
			expect(rest.nodes).toHaveLength(1);
			expect(rest.pageInfo.hasNextPage).toBe(false);
			const nodes = [...me.searchRoutes.nodes, ...rest.nodes];
			for (const node of nodes) {
				expect(node.id).toMatch(/^\d{19}$/);
				expect(typeof node.athlete.id).toBe('string');
			}
			const expected = fake.expected('strava');
			expect(nodes.filter((n) => n.athlete.id === '3001').map((n) => n.id)).toEqual(
				expected.ids.routes
			);
			expect(expected.references).toEqual(
				nodes
					.filter((n) => n.athlete.id !== '3001')
					.map((n) => ({
						name: n.title,
						url: `${fake.origin('strava')}/routes/${n.id}`,
						sourceId: n.id,
						coordinate: null
					}))
			);
			// A type filter applies; without searchArgs the server falls over.
			expect(
				(await routesPage('0', { routeTypes: ['Hike'] })).json().me.searchRoutes.nodes
			).toHaveLength(1);
			expect((await routesPage('0', { routeTypes: [] })).json().me.searchRoutes.nodes).toEqual([]);
			const broken = await post(
				'/api/next/data/routes/my-routes',
				{ pageSize: 50, after: '0' },
				{ 'x-csrf-token': await mint() }
			);
			expect(broken.status).toBe(500);
		});

		it('the token dies with the session; signing in again needs a fresh one', async () => {
			const old = await mint();
			fake.logout('strava');
			// Signed out, the mint still answers — with a token nothing accepts.
			const anonymous = await mint();
			expect(anonymous).not.toBe(old);
			const signedOut = await post('/api/next/data/routes/my-routes', query(), {
				'x-csrf-token': anonymous
			});
			expect(signedOut.status).toBe(403);
			fake.login('strava');
			const stale = await post('/api/next/data/routes/my-routes', query(), { 'x-csrf-token': old });
			expect(stale.status).toBe(403);
			expect((await routesPage()).status).toBe(200);
		});

		it('signed out: null athlete, 401 for XHR listings, sign-in page for GPX', async () => {
			const opts = { cookie: false } as const;
			const current = (await get('/frontend/athletes/current', opts)).json();
			expect(current.currentAthlete).toBeNull();
			for (const path of [
				'/athlete/training_activities?page=1',
				'/athletes/3001/photos',
				'/activities/11200000005/streams?stream_types[]=time'
			]) {
				const res = await get(path, opts);
				expect(res.status).toBe(401);
				expect(res.body).toHaveLength(0);
			}
			const gpx = await site(fake, 'strava', '/activities/11200000005/export_gpx', opts);
			expect(gpx.status).toBe(302);
			expect(gpx.headers.location).toBe('/login');
		});

		it('photos: cursor paging, a video among them, files on the photo host without a session', async () => {
			const expected = fake.expected('strava');
			const items: any[] = [];
			let cursor: string | null = null;
			do {
				const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
				const page: any = (await get(`/athletes/3001/photos?per_page=20${q}`)).json();
				expect(page.items.length).toBeLessThanOrEqual(3);
				items.push(...page.items);
				cursor = page.has_more ? page.next_cursor : null;
			} while (cursor);
			expect(items).toHaveLength(4);
			expect(items.filter((p) => p.video === null).map((p) => p.photo_id)).toEqual(
				expected.ids.photos
			);
			expect(items.every((p) => p.owner_id === 3001 && p.lat === null)).toBe(true);
			expect(items[0].caption_escaped).toBe('Summit &amp; snacks &lt;3');
			expect((await get('/athletes/3001/photos?cursor=1,1')).json().items).toEqual([]);
			expect((await get('/athletes/3999/photos')).status).toBe(404);

			fake.resetLog();
			const { host, path } = toPath(items[0].large);
			expect(host).toBe('cdn.strava.localhost');
			const image = await http(fake, host, path);
			expect(image.status).toBe(200);
			expect(image.headers['content-type']).toBe('image/jpeg');
			expect(Number(image.headers['content-length'])).toBe(image.body.length);
			expect(fake.stats('strava')).toMatchObject({ apiRequests: 0, assetRequests: 1 });
		});

		it('expected(): GPS activities, own routes, photos without the video, one starred collection', () => {
			expect(fake.expected('strava')).toMatchObject({
				account: { id: '3001', displayName: 'Test R.' },
				counts: { tracks: 4, routes: 3, waypoints: 0, areas: 0, collections: 1, photos: 3 }
			});
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
						if (k === 'user_email' || k === 'username') continue;
						out[k] = strip(v);
					}
					return out;
				}
				return value;
			};
			const g = fake.objects('gaiagps');
			// Listings never say who owns an object; details do.
			const theirs = new Set(['gt-9001', 'gr-9002', 'gf-9004']);
			const mine = (o: { summary: any }) => !theirs.has(o.summary.id);
			const both = (o: { summary: any; detail: any }) => [o.summary, o.detail];
			const a = fake.objects('alltrails');
			const s = fake.objects('strava');
			const mineAt = (o: any) => o.user.id === 7001;
			const owned = [
				...[...g.tracks, ...g.routes, ...g.waypoints, ...g.areas, ...g.photos, ...g.folders]
					.filter(mine)
					.flatMap(both),
				...[...a.tracks, ...a.maps].filter((t) => mineAt(t.summary)).flatMap(both),
				...a.photos.filter(mineAt),
				...a.lists.flatMap((l) => [l.list, ...l.items]),
				// Of a platform trail only these may ever be kept.
				...a.trails.map((t) => ({ id: t.id, name: t.name, slug: t.slug, location: t.location })),
				...s.activities.flatMap((activity) => [activity.summary, activity.streams]),
				...s.routes.filter((route: any) => route.athlete.id === '3001'),
				...s.photos
			];
			const text = JSON.stringify(strip(owned));
			// Decoded polylines too, since the encoded form hides the digits.
			const decoded = [...a.tracks, ...a.maps]
				.filter((l) => mineAt(l.summary))
				.flatMap((l) => {
					const d = l.detail as any;
					const segments = d.tracks?.[0].lineTimedSegments ?? d.routes[0].lineSegments;
					return segments.map((s: any) => decodePolyline(s.polyline.pointsData));
				})
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
			expect(g.folders.map((f) => f.summary)).toEqual(await gaiaAll(fake, 'folder'));
			expect(g.photos.map((p) => p.summary)).toEqual(await gaiaAll(fake, 'photo'));
			const detail = (await site(fake, 'gaiagps', '/api/objects/track/gt-3001/')).json();
			expect(g.tracks.find((t) => t.summary.id === 'gt-3001')?.detail).toEqual(detail);
			const a = fake.objects('alltrails');
			expect(a.maps.map((m) => m.summary)).toEqual(
				await atAll(fake, 'maps?presentation_type=map', 'maps')
			);
			expect(a.lists.map((l) => l.list)).toEqual(await atAll(fake, 'lists', 'lists'));
			const s = fake.objects('strava');
			const xhr = { headers: { 'X-Requested-With': 'XMLHttpRequest' } };
			const listed = [1, 2].map((page) =>
				site(fake, 'strava', `/athlete/training_activities?page=${page}`, xhr)
			);
			const models = (await Promise.all(listed)).flatMap((res) => res.json().models);
			expect(s.activities.map((activity) => activity.summary)).toEqual(models);
		});

		it('is deterministic across server instances (modulo the port)', async () => {
			const other = await startFakeSource({ port: 0, dataset: 'small' });
			try {
				const norm = (f: FakeSource, p: Platform) =>
					JSON.stringify(f.objects(p)).replaceAll(`:${f.port}`, ':PORT');
				expect(norm(other, 'gaiagps')).toBe(norm(fake, 'gaiagps'));
				expect(norm(other, 'alltrails')).toBe(norm(fake, 'alltrails'));
				expect(norm(other, 'strava')).toBe(norm(fake, 'strava'));
				const route = fake.expected('strava').ids.routes[0]!;
				expect(
					other.nativeGpx('strava', 'route', route).equals(fake.nativeGpx('strava', 'route', route))
				).toBe(true);
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
					match: '^/api/objects/track/$',
					skip: 1,
					count: 2,
					action: { kind: 'status' as const, status: 429, retryAfter: 2 }
				}
			];
			fake.setFaults(faults);
			const statuses: number[] = [];
			for (let i = 0; i < 5; i++) {
				const res = await site(fake, 'gaiagps', '/api/objects/track/');
				statuses.push(res.status);
				if (res.status === 429) expect(res.headers['retry-after']).toBe('2');
			}
			expect(statuses).toEqual([200, 429, 429, 200, 200]);
			// Non-matching path and other platform are untouched.
			expect((await site(fake, 'gaiagps', '/api/objects/route/')).status).toBe(200);
			fake.setFaults(faults);
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(429);
		});

		it('first open fault wins; platform filter applies', async () => {
			fake.setFaults([
				{ platform: 'alltrails', match: '/(me|user/)$', action: { kind: 'status', status: 500 } },
				{ match: '/(me|user/)$', count: 1, action: { kind: 'status', status: 403, body: 'nope' } },
				{ match: '/(me|user/)$', action: { kind: 'status', status: 404 } }
			]);
			const first = await site(fake, 'gaiagps', '/api/v3/user/');
			expect(first.status).toBe(403);
			expect(first.text).toBe('nope');
			expect((await site(fake, 'gaiagps', '/api/v3/user/')).status).toBe(404);
			expect((await site(fake, 'alltrails', '/api/alltrails/me')).status).toBe(500);
		});

		it('403 on GPX endpoints leaves JSON details reachable', async () => {
			fake.setFaults([{ match: '\\.gpx$', action: { kind: 'status', status: 403 } }]);
			expect((await site(fake, 'gaiagps', '/api/objects/track/gt-3001.gpx')).status).toBe(403);
			expect((await site(fake, 'gaiagps', '/api/objects/track/gt-3001/')).status).toBe(200);
		});

		it('challenge answers 200 text/html', async () => {
			fake.setFaults([{ match: '/api/', count: 1, action: { kind: 'challenge' } }]);
			const res = await site(fake, 'gaiagps', '/api/objects/waypoint/');
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toMatch(/^text\/html/);
			expect(res.text).toContain('Checking your browser');
			expect((await site(fake, 'gaiagps', '/api/objects/waypoint/')).json()).toHaveLength(6);
		});

		it('drop destroys the socket and logs status 0', async () => {
			fake.setFaults([{ match: '/api/objects/area/', count: 1, action: { kind: 'drop' } }]);
			await expect(site(fake, 'gaiagps', '/api/objects/area/')).rejects.toThrow();
			await sleep(20);
			const entry = fake.log().find((e) => e.path === '/api/objects/area/');
			expect(entry?.status).toBe(0);
			expect(entry!.end).toBeGreaterThanOrEqual(entry!.start);
			expect((await site(fake, 'gaiagps', '/api/objects/area/')).status).toBe(200);
		});

		it('expire-session answers unauthenticated until login()', async () => {
			fake.setFaults([{ match: '/api/', skip: 1, count: 1, action: { kind: 'expire-session' } }]);
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(200);
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(403);
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(403);
			expect((await site(fake, 'gaiagps', '/api/v3/user/')).json().is_authenticated).toBe(false);
			// Only that platform's session died.
			expect((await site(fake, 'alltrails', '/api/alltrails/me')).status).toBe(200);
			fake.login('gaiagps');
			expect((await site(fake, 'gaiagps', '/api/objects/track/')).status).toBe(200);

			fake.setFaults([
				{ platform: 'alltrails', match: '/api/', count: 1, action: { kind: 'expire-session' } }
			]);
			const res = await site(fake, 'alltrails', '/api/alltrails/me');
			expect(res.status).toBe(302);
			expect((await site(fake, 'alltrails', '/')).text).toContain('href="/login"');
			await site(fake, 'alltrails', '/login', { method: 'POST', body: '' });
			expect((await site(fake, 'alltrails', '/api/alltrails/me')).status).toBe(200);
		});

		it('schema-drift renames the listing key, or wraps a bare-array listing', async () => {
			fake.setFaults([{ match: '/api/', action: { kind: 'schema-drift' } }]);
			const g = (await site(fake, 'gaiagps', '/api/objects/track/')).json();
			expect(Array.isArray(g)).toBe(false);
			expect(g.results).toHaveLength(8);
			expect(g.count).toBe(8);
			const a = (await site(fake, 'alltrails', '/api/alltrails/users/7001/lists')).json();
			expect(a.lists).toBeUndefined();
			expect(a.entries).toHaveLength(3);
			// Not a listing: served normally.
			expect((await site(fake, 'gaiagps', '/api/v3/user/')).json().id).toBe(1001);
		});

		it('delay responds normally afterwards and survives a client abort', async () => {
			fake.setFaults([{ match: '/api/v3/user/', action: { kind: 'delay', ms: 120 } }]);
			const t0 = performance.now();
			const res = await site(fake, 'gaiagps', '/api/v3/user/');
			expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
			expect(res.json().id).toBe(1001);

			fake.resetLog();
			await new Promise<void>((resolve) => {
				const req = httpRequest({
					host: '127.0.0.1',
					port: fake.port,
					path: '/api/v3/user/',
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
			expect((await site(fake, 'gaiagps', '/api/v3/user/')).status).toBe(200);
		});
	});

	describe('log + stats', () => {
		it('classifies lanes and records timings', async () => {
			fake.resetLog();
			await site(fake, 'gaiagps', '/api/v3/user/');
			await site(fake, 'gaiagps', '/robots.txt');
			await http(fake, 'cdn.gaia.localhost', '/photos/gp-7001/full');
			await site(fake, 'alltrails', '/api/alltrails/me', { cookie: false });
			const log = fake.log();
			expect(log.map((e) => [e.platform, e.lane, e.method, e.path, e.status])).toEqual([
				['gaiagps', 'api', 'GET', '/api/v3/user/', 200],
				['gaiagps', 'page', 'GET', '/robots.txt', 200],
				['gaiagps', 'asset', 'GET', '/photos/gp-7001/full', 200],
				['alltrails', 'api', 'GET', '/api/alltrails/me', 302]
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
				site(fake, 'gaiagps', '/api/v3/user/'),
				site(fake, 'gaiagps', '/api/objects/track/'),
				site(fake, 'gaiagps', '/api/objects/route/'),
				site(fake, 'alltrails', '/api/alltrails/me')
			]);
			const parallel = fake.stats('gaiagps');
			expect(parallel.apiRequests).toBe(3);
			expect(parallel.peakApiConcurrency).toBe(3);
			expect(parallel.minApiGapMs).toBeLessThan(60);
			expect(fake.stats('alltrails').peakApiConcurrency).toBe(1);

			fake.setFaults([]);
			fake.resetLog();
			for (let i = 0; i < 3; i++) {
				await site(fake, 'gaiagps', '/api/v3/user/');
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

	it('expected() describes a photo-heavy Gaia account and empty AllTrails and Strava ones', async () => {
		const expected = fake.expected('gaiagps');
		expect(expected.counts).toEqual({
			tracks: 2,
			routes: 0,
			// Every Gaia photo hangs off a waypoint.
			waypoints: 2,
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
		expect((await site(fake, 'alltrails', '/api/alltrails/users/7001/maps')).json()).toMatchObject({
			maps: [],
			pageInfo: { totalItemCount: 0, hasNextPage: false }
		});
		expect((await site(fake, 'gaiagps', '/api/objects/folder/')).json()).toEqual([]);
		expect(fake.expected('strava').counts).toEqual(fake.expected('alltrails').counts);
		expect(fake.expected('strava').references).toEqual([]);
	});

	it('lists every photo in one unpaginated response', async () => {
		const photos = (await site(fake, 'gaiagps', '/api/objects/photo/')).json();
		expect(photos).toHaveLength(PHOTOS);
		const expected = fake.expected('gaiagps');
		expect(photos.map((p: any) => p.id)).toEqual(expected.ids.photos);
		const tracks = (await site(fake, 'gaiagps', '/api/objects/track/')).json();
		expect(tracks.map((t: any) => t.id)).toEqual(expected.ids.tracks);
	});

	it('streams a full-size photo with the right Content-Length and flat memory', async () => {
		const listed = (await site(fake, 'gaiagps', '/api/objects/photo/')).json();
		const urls: string[] = [];
		for (const p of listed.slice(200, 206)) {
			const hop = await site(fake, 'gaiagps', `/api/objects/photo/${p.id}/image/full/`);
			urls.push(String(hop.headers.location));
		}
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
		// Closed sockets hand their buffers back a turn later.
		await new Promise((resolve) => setTimeout(resolve, 200));
		globalThis.gc?.();
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
		SENTINELS.sessionCookie.strava,
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
