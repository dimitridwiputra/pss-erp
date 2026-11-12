import { z } from 'zod';

/**
 * GET /api/experience/shell — the web app shell's navigation for the signed-in viewer: the work
 * screens they hold a permission for, grouped by work (DESIGN_SYSTEM §7.1). Decided server-side
 * from identity's grants (RBAC-003); a screen without permission is absent.
 */
export const ExperienceShellViewSchema = z.strictObject({
  view: z.literal('shell'),
  version: z.literal(1),
  viewer: z.strictObject({ displayName: z.string().min(1) }),
  sections: z.array(z.strictObject({
    key: z.string().min(1),
    label: z.string().min(1),
    items: z.array(z.strictObject({
      key: z.string().min(1),
      label: z.string().min(1),
      description: z.string().min(1),
      href: z.string().startsWith('/'),
      icon: z.string().min(1),
    })).min(1),
  })),
  /** True when identity's grants could not be read, so the menu may be short. */
  incomplete: z.boolean(),
});

export type ExperienceShellView = z.infer<typeof ExperienceShellViewSchema>;
