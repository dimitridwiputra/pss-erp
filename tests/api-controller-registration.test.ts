import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findUnapprovedApiControllers, hasClassLevelGuard } from '../scripts/check-api-controller-registration.mjs';

describe('RBAC-002.NC02 API controller registration', () => {
  it('allows the currently reviewed foundation controllers', () => {
    expect(findUnapprovedApiControllers(`@Module({ controllers: [HealthController, IdentityController, IdentityAdminController, ApprovalController, WmsController] }) class AppModule {}`)).toEqual([]);
  });

  it('rejects operational controllers until their routes pass authorization review', () => {
    const violations = findUnapprovedApiControllers(`@Module({ controllers: [HealthController, PosController, WmsController] }) class AppModule {}`);
    expect(violations).toEqual([expect.stringContaining('PosController')]);
  });

  describe('MVP-OD-5 PosController behind the demo switch', () => {
    const main = `@Module({ controllers: [HealthController, PosController] }) class AppModule {}`;

    it('allows PosController when the class carries the demo guard', () => {
      const guarded = `@Controller()\n@UseGuards(DemoPosFeatureGuard)\nexport class PosController {}`;
      expect(findUnapprovedApiControllers(main, { PosController: guarded })).toEqual([]);
    });

    it.each([
      ['no guard', `@Controller()\nexport class PosController {}`],
      ['a different guard', `@Controller()\n@UseGuards(SomeOtherGuard)\nexport class PosController {}`],
      ['the guard on a method only', `@Controller()\nexport class PosController {\n  @UseGuards(DemoPosFeatureGuard)\n  @Get('kasir/x') x() {}\n}`],
      ['the guard on another class', `@UseGuards(DemoPosFeatureGuard)\nclass Other {}\n@Controller()\nexport class PosController {}`],
    ])('rejects PosController with %s', (_case, source) => {
      expect(findUnapprovedApiControllers(main, { PosController: source }))
        .toEqual([expect.stringContaining('DemoPosFeatureGuard')]);
    });

    it('rejects PosController when its source cannot be inspected', () => {
      expect(findUnapprovedApiControllers(main)).toEqual([expect.stringContaining('DemoPosFeatureGuard')]);
    });

    it('recognises the real PosController as guarded', () => {
      const source = readFileSync(new URL('../apps/api/src/pos.controller.ts', import.meta.url), 'utf8');
      expect(hasClassLevelGuard(source, 'PosController', 'DemoPosFeatureGuard')).toBe(true);
    });
  });

  it('rejects computed registrations that cannot be reviewed statically', () => {
    expect(findUnapprovedApiControllers(`@Module({ controllers: [...controllers] }) class AppModule {}`))
      .toEqual([expect.stringContaining('Unapproved API controller')]);
  });
});
