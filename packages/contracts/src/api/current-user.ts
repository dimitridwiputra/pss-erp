import { z } from 'zod';

export const CurrentUserResponseSchema = z.strictObject({
  id: z.uuid(),
  organizationId: z.uuid(),
  displayName: z.string().min(1),
  primaryBranchId: z.uuid().nullable(),
});

export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;
