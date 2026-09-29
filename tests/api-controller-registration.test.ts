import { describe, expect, it } from 'vitest';
import { findUnapprovedApiControllers } from '../scripts/check-api-controller-registration.mjs';

describe('RBAC-002.NC02 API controller registration', () => {
  it('allows the currently reviewed foundation controllers', () => {
    expect(findUnapprovedApiControllers(`@Module({ controllers: [HealthController, IdentityController, IdentityAdminController, ApprovalController, WmsController] }) class AppModule {}`)).toEqual([]);
  });

  it('rejects operational controllers until their routes pass authorization review', () => {
    const violations = findUnapprovedApiControllers(`@Module({ controllers: [HealthController, PosController, WmsController] }) class AppModule {}`);
    expect(violations).toEqual([expect.stringContaining('PosController')]);
  });

  it('rejects computed registrations that cannot be reviewed statically', () => {
    expect(findUnapprovedApiControllers(`@Module({ controllers: [...controllers] }) class AppModule {}`))
      .toEqual([expect.stringContaining('Unapproved API controller')]);
  });
});
