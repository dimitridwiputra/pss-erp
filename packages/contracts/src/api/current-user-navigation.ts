import { z } from 'zod';

export const NavigationItemSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
});

export const NavigationAppSchema = z.strictObject({
  app: z.enum(['sales', 'gudang', 'antar', 'admin', 'supervisor', 'keuangan', 'control_station', 'konsol']),
  accessPermission: z.string().min(1),
  label: z.string().min(1),
  items: z.array(NavigationItemSchema),
});

export const CurrentUserNavigationResponseSchema = z.strictObject({
  apps: z.array(NavigationAppSchema),
  bottomNav: z.array(NavigationItemSchema.extend({ href: z.string().min(1) })).max(4),
  bottomNavTrimmed: z.boolean(),
});

export type CurrentUserNavigationResponse = z.infer<typeof CurrentUserNavigationResponseSchema>;
