# HTTP boundary

NestJS exception filter shared by backend deployables. It converts registered errors, HTTP exceptions, and Zod validation failures to the PSS RFC 9457 contract without returning technical details.

Use `ZodValidationPipe` with the canonical Zod schema on each protected controller parameter (`@Body`, `@Query`, or `@Param`). It returns the parsed value or throws `MalformedRequestError`, which `ProblemExceptionFilter` renders as HTTP 400 `application/problem+json` with safe field paths. Domain `VALIDATION_FAILED` remains HTTP 422. A raw Zod error outside the request pipe is treated as an internal error rather than blaming the caller. The filter also returns the active `traceparent` so an error response carries the same W3C trace ids as the request log.

## Field classification and masking (SEC-001)

`field-classification.ts` owns the five classifications `PUBLIC / INTERNAL / CONFIDENTIAL /
PERSONAL / SENSITIVE_PERSONAL` (PRD §78.1) and the mechanism for marking a contract field:

```ts
const CustomerResponseSchema = z.strictObject({
  name: classified(z.string(), 'PERSONAL'),
  nik: classified(z.string(), 'SENSITIVE_PERSONAL'),
  status: classified(z.enum(['ACTIVE', 'INACTIVE']), 'INTERNAL'),
});
```

- `classified(schema, classification)` attaches the annotation through Zod's own `.meta()`
  registry, so it survives `.optional()`, `.nullable()`, and `.array()`.
- `classifiedFieldsOf(objectSchema)` derives the personal-data map from the schema (SEC-001.R05)
  and `unclassifiedPersonalFields(objectSchema, pattern)` reports personal fields with no
  classification (SEC-001.AC03).
- `maskSensitiveValue` / `presentSensitiveValue` / `presentSensitiveField` mask a value and
  reveal it only when the caller holds the `*.view_full` permission for that kind of data.
  A full-value read must be audited by the caller (SEC-001.BR02).
- `maskClassifiedRecord` masks a whole record before it is logged, exported, or loaded into DW.

The same five classifications also exist as `AuditChangeSchema.shape.classification` in
`@pss/audit`. A package cannot import a domain (PLT-002), so a parity test in
`tests/sec-001-field-classification.test.ts` keeps the two declarations identical. The single
declaration belongs in `@pss/contracts`; that move is an open decision.
