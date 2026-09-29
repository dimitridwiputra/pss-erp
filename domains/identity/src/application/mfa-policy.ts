import { DomainError } from '@pss/contracts';

/** Only IdP-verified claims are accepted. A refreshed access token does not extend the step-up window. */
export function requireRecentMfa(
  claims: { authenticationAt: number | undefined; authenticationMethods: readonly string[] },
  nowSeconds = Math.floor(Date.now() / 1000),
  stepUpMinutes = 15,
): void {
  const hasTotp = claims.authenticationMethods.includes('otp');
  const age = claims.authenticationAt === undefined ? Infinity : nowSeconds - claims.authenticationAt;
  if (!hasTotp || !Number.isFinite(age) || age < 0 || age > stepUpMinutes * 60) {
    throw new DomainError('MFA_REQUIRED');
  }
}
