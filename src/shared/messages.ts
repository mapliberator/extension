import { z } from 'zod';

export const SourceIdSchema = z.enum(['gaiagps', 'alltrails', 'strava', 'garmin']);

export const OpenExportMessage = z.object({
	type: z.literal('open-export'),
	source: SourceIdSchema.optional()
});
export type OpenExportMessage = z.infer<typeof OpenExportMessage>;
