import type { AdapterFactory, SourceId } from '../shared/models';
import { createAllTrailsAdapter } from './alltrails';
import { createGaiaAdapter } from './gaia';
import { sourceHosts } from './hosts';
import { createStravaAdapter } from './strava';

export interface SourceDescriptor {
	id: SourceId;
	label: string;
	/** Hostnames the popup recognises on the active tab. */
	siteHosts: string[];
	create: AdapterFactory;
}

export const SOURCES: SourceDescriptor[] = [
	{
		id: 'gaiagps',
		label: 'Gaia GPS',
		siteHosts: ['gaiagps.com'],
		create: createGaiaAdapter
	},
	{
		id: 'alltrails',
		label: 'AllTrails',
		siteHosts: ['alltrails.com'],
		create: createAllTrailsAdapter
	},
	{
		id: 'strava',
		label: 'Strava',
		siteHosts: ['strava.com'],
		create: createStravaAdapter
	}
];

export function findSource(id: string | null | undefined): SourceDescriptor | null {
	return SOURCES.find((source) => source.id === id) ?? null;
}

export function sourceForUrl(url: string | undefined): SourceDescriptor | null {
	if (!url) return null;
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return null;
	}
	const hosts = sourceHosts(import.meta.env.MODE);
	return (
		SOURCES.find(
			(source) =>
				source.siteHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)) ||
				hosts[source.id].origins.some((origin) => new URL(origin).hostname === hostname)
		) ?? null
	);
}
