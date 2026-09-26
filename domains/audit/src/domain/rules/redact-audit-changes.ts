import type { AuditChange } from '../audit-entry';

const sensitivePath = /(?:^|[._-]|\[)(?:nik|npwp|phone|telephone|telepon|account|rekening|token|secret|password|credential|authorization)(?:$|[._-]|\])/i;
const longNumber = /\b\d{10,16}\b/g;
const bearerToken = /\bBearer\s+\S+/gi;

function redactValue(value: string | number | boolean | null | undefined, sensitive: boolean) {
  if (value === undefined) return undefined;
  if (sensitive) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(bearerToken, '[REDACTED]').replace(longNumber, '[REDACTED]');
  return value;
}

export function redactAuditChanges(changes: readonly AuditChange[]) {
  return changes.map((change) => {
    const separatedPath = change.path.replace(/([a-z])([A-Z])/g, '$1_$2');
    const sensitive = change.classification === 'PERSONAL' || change.classification === 'SENSITIVE_PERSONAL' || sensitivePath.test(separatedPath);
    return {
      path: change.path,
      classification: change.classification,
      ...(change.before !== undefined ? { before: redactValue(change.before, sensitive) } : {}),
      ...(change.after !== undefined ? { after: redactValue(change.after, sensitive) } : {}),
    };
  });
}
