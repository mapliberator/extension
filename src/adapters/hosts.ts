/**
 * Hosts each source adapter may touch. This is the single source of truth for the manifest's
 * optional host permissions, the bridge allowlist, and the worker's asset allowlist.
 *
 * Plain module on purpose: it is imported by `wxt.config.ts` (Node) as well as by extension code,
 * so it must not touch `import.meta.env` or any browser API.
 *
 * The `e2e` build mode swaps the real platforms for `tools/fake-source`, which serves
 * Gaia- and AllTrails-shaped APIs on `*.localhost`.
 */
export type SourceId = 'gaiagps' | 'alltrails';

export interface SourceHosts {
	/** API origins: the bridge executor refuses anything else. */
	origins: string[];
	/** Photo/CDN origins: fetched directly by the worker. */
	assetOrigins: string[];
}

export const FAKE_SOURCE_PORT = 4610;

const REAL: Record<SourceId, SourceHosts> = {
	gaiagps: {
		origins: ['https://www.gaiagps.com'],
		// Photo URLs live on the site host, answer without a session and redirect to signed URLs
		// on the photo host (docs/phase0-findings.md).
		assetOrigins: ['https://www.gaiagps.com', 'https://photos.gaiagps.xyz']
	},
	alltrails: {
		origins: ['https://www.alltrails.com'],
		// Photo URLs live on the site host, need the app key rather than a session, and redirect
		// to the image host (docs/phase0-findings.md).
		assetOrigins: ['https://www.alltrails.com', 'https://images.alltrails.com']
	}
};

// `__E2E__` is a build-time constant (wxt.config.ts): production bundles drop the fake hosts
// entirely. It is undefined under Node (config, scripts, tests), where both tables are wanted.
declare const __E2E__: boolean | undefined;

const FAKE: Record<SourceId, SourceHosts> | null =
	typeof __E2E__ !== 'undefined' && !__E2E__
		? null
		: {
				gaiagps: {
					origins: [`http://gaia.localhost:${FAKE_SOURCE_PORT}`],
					assetOrigins: [
						`http://gaia.localhost:${FAKE_SOURCE_PORT}`,
						`http://cdn.gaia.localhost:${FAKE_SOURCE_PORT}`
					]
				},
				alltrails: {
					origins: [`http://alltrails.localhost:${FAKE_SOURCE_PORT}`],
					assetOrigins: [
						`http://alltrails.localhost:${FAKE_SOURCE_PORT}`,
						`http://cdn.alltrails.localhost:${FAKE_SOURCE_PORT}`
					]
				}
			};

export function sourceHosts(mode: string): Record<SourceId, SourceHosts> {
	return mode === 'e2e' && FAKE ? FAKE : REAL;
}

/** `https://host:port` → `https://host/*` (match patterns carry no port). */
export function originToMatchPattern(origin: string): string {
	const url = new URL(origin);
	return `${url.protocol}//${url.hostname}/*`;
}

export function matchPatternsFor(hosts: SourceHosts): string[] {
	return [...new Set([...hosts.origins, ...hosts.assetOrigins].map(originToMatchPattern))];
}
