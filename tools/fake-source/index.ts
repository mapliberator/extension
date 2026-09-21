/** Synthetic Gaia-/AllTrails-shaped source server. The contract is API.md. */
export { startFakeSource } from './server.ts';
export { SENTINELS, trailCoordinatesP5 } from './sentinels.ts';
export { decodePolyline, encodePolyline } from './polyline.ts';
export type {
	AllTrailsObjects,
	DatasetOptions,
	ExpectedArchive,
	FakeSource,
	Fault,
	FaultAction,
	GaiaObjects,
	Json,
	Lane,
	LineObject,
	Platform,
	RequestLogEntry,
	SessionCookie,
	SourceStats,
	StartOptions
} from './types.ts';
