# HTTP boundary

NestJS exception filter shared by backend deployables. It converts registered errors, HTTP exceptions, and Zod validation failures to the PSS RFC 9457 contract without returning technical details.

Use `ZodValidationPipe` with the canonical Zod schema on each protected controller parameter (`@Body`, `@Query`, or `@Param`). It returns the parsed value or throws `MalformedRequestError`, which `ProblemExceptionFilter` renders as HTTP 400 `application/problem+json` with safe field paths. Domain `VALIDATION_FAILED` remains HTTP 422. A raw Zod error outside the request pipe is treated as an internal error rather than blaming the caller.
