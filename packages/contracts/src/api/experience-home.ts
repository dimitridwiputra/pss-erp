import { z } from 'zod';
import { UtcTimestampSchema } from '../primitives';
import { ExperienceSourceReportSchema } from './experience-approval-inbox';

/** F0 home is an entitlement summary, not an operational work queue. */
export const ExperienceHomeViewSchema = z.strictObject({
  view: z.literal('home'),
  version: z.literal(1),
  viewer: z.strictObject({ displayName: z.string().min(1) }),
  products: z.array(z.strictObject({ key: z.string().min(1), label: z.string().min(1) })).nullable(),
  primaryAction: z.strictObject({ label: z.string().min(1), href: z.string().startsWith('/') }).nullable(),
  sources: z.array(ExperienceSourceReportSchema).min(1),
  incomplete: z.boolean(),
  generatedAt: UtcTimestampSchema,
});

export type ExperienceHomeView = z.infer<typeof ExperienceHomeViewSchema>;
