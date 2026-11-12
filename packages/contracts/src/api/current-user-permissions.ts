import { z } from 'zod';

export const UserPermissionGrantSchema = z.strictObject({
  // Appendix D includes two-part permissions such as audit.export.
  permission: z.string().regex(/^[a-z_]+(?:\.[a-z_]+){1,}$/),
  scopeType: z.enum(['ORGANIZATION', 'BRANCH', 'WAREHOUSE', 'TERRITORY', 'PRINCIPAL', 'CUSTOMER', 'SALES_TEAM', 'OWN']),
  scopeId: z.uuid().nullable(),
});

export const CurrentUserPermissionsResponseSchema = z.strictObject({
  userId: z.uuid(),
  grants: z.array(UserPermissionGrantSchema),
});

export type CurrentUserPermissionsResponse = z.infer<typeof CurrentUserPermissionsResponseSchema>;
export type UserPermissionGrant = z.infer<typeof UserPermissionGrantSchema>;
