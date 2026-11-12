// The audit-context shape and its resolver live in `@pss/audit`, derived from the entry schema itself.
// `domains/inventory`, `domains/master-data` and `domains/commercial` each carried a local copy; this
// re-export keeps the import path inside this domain stable while there is one definition.
export {
  ActorInputSchema, OptionalAuditContextSchema, SourceSchema, resolveAuditContext,
  type OptionalAuditContext,
} from '@pss/audit';
