# @pss/observability

The first OBS-001 slice provides `createHttpRequestLogging(service)` for the four NestJS backend entry points. It accepts safe incoming `X-Request-Id` and `X-Correlation-Id` values or generates new IDs, returns both response headers, and emits one Pino JSON line when a request completes. Request URLs, query strings, headers, and bodies are excluded from the logged fields. The error filter uses the same IDs and records only a fixed code for unexpected errors.

This is partial OBS-001 coverage. Business scope and trace IDs are not populated until identity and OpenTelemetry are integrated. Nest startup logs still use its framework format. Event/job propagation, schema-driven PII masking, exporter, sampling, and retention remain open; see `docs/IMPLEMENTATION_STATUS.md`. Do not pass raw request or domain payloads to the logger.
