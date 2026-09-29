import { describe, expect, it } from 'vitest';
import { requireRecentMfa } from '../src/application/mfa-policy';

describe('IDN-002 server-side step-up policy', () => {
  const now = 1_800_000_000;

  it('accepts a recent IdP TOTP claim and rejects password-only, absent, stale, or future claims', () => {
    expect(() => requireRecentMfa({ authenticationAt: now - 899, authenticationMethods: ['pwd', 'otp'] }, now)).not.toThrow();
    for (const claims of [
      { authenticationAt: now, authenticationMethods: ['pwd'] },
      { authenticationAt: undefined, authenticationMethods: ['otp'] },
      { authenticationAt: now - 901, authenticationMethods: ['otp'] },
      { authenticationAt: now + 10, authenticationMethods: ['otp'] },
    ]) {
      expect(() => requireRecentMfa(claims, now)).toThrowError('MFA_REQUIRED');
    }
  });
});
