import { Injectable, type CanActivate } from '@nestjs/common';
import { DomainError } from '@pss/contracts';

/**
 * MVP-OD-5 (docs/decisions/2026-10-01-mvp-demo-pos-exposure.md): the POS API is a demo build, not
 * a released F11 feature. It answers only when `PSS_DEMO_POS_ENABLED` is exactly `true`, and never
 * when `NODE_ENV` is `production`, whatever the flag says. Anything else — unset, `1`, `TRUE` —
 * is off: the switch fails closed.
 */
export function isDemoPosEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NODE_ENV === 'production') return false;
  return environment.PSS_DEMO_POS_ENABLED === 'true';
}

/**
 * Applied at class level to every controller serving `/pos/*` or `/kasir/*`. A guard runs before
 * any pipe or handler, so a disabled route reveals nothing about its input shape or its data.
 * `scripts/check-api-controller-registration.mjs` refuses to register `PosController` without it.
 */
@Injectable()
export class DemoPosFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!isDemoPosEnabled()) throw new DomainError('FEATURE_DISABLED');
    return true;
  }
}
