# @pss/observability

## `createHttpRequestLogging(service)` — HTTP entry point

Express/Nest middleware for the four NestJS backend entry points. It reuses safe incoming
`X-Request-Id` and `X-Correlation-Id` values or generates new IDs, continues a W3C
`traceparent` (or starts one), and returns `X-Request-Id`, `X-Correlation-Id`, `traceparent`,
and `tracestate` as response headers. One Pino JSON line is written when a request completes.

Logging is allow-listed: request URLs, query strings, headers, and bodies never reach the
logger. `createProblemDetails`'s error filter reuses the same IDs and records only a fixed
code for unexpected errors.

## Trace context

`src/trace-context.ts` implements the [W3C Trace Context](https://www.w3.org/TR/trace-context/)
wire format: strict `traceparent`/`tracestate` parsing that rejects all-zero and malformed
ids, and header formatting. Incoming ids are validated, never trusted.

`src/trace-context-storage.ts` keeps the active `TraceContext` in an `AsyncLocalStorage`
scope. `createServiceLogger`'s `mixin` writes `traceId`/`spanId` on every line written inside
that scope, so a domain logger created during a request, job, or consumer gets the ids for
free. Outside a scope no trace fields are written.

`src/event-trace-context.ts` crosses the outbox → worker → consumer boundary.
`withEventTraceContext(envelope, run)` child-spans one event: the trace id comes from the
envelope's `traceparent` when present, otherwise it is derived deterministically from
`correlationId` (SHA-256, first 16 bytes). `correlationId` is the only correlation carrier
the canonical `EventEnvelopeSchema` defines, and OBS-001.AC01 requires one correlation per
business flow, so the derivation is what makes request → consumer a single trace.
`eventTraceAttributes` returns the allow-listed event identity for log bindings; payloads are
never copied into logs.

## Open

`EventEnvelopeSchema` is a `strictObject` with no `traceparent` field, so a consumer can only
*derive* the trace id from `correlationId`; a caller's own W3C trace is not forwarded verbatim
until PLT-003 adds the field (the helper already accepts it). Nest startup logs still use the
framework format. OpenTelemetry SDK instrumentation, exporter, sampling, and
`observability.log_retention_days` retention remain open; see `docs/IMPLEMENTATION_STATUS.md`
and OD-185. Do not pass raw request or domain payloads to the logger.
