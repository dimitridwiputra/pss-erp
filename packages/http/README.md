# HTTP boundary

NestJS exception filter shared by backend deployables. It converts registered errors, HTTP exceptions, and Zod validation failures to the PSS RFC 9457 contract without returning technical details.

Use `ZodValidationPipe` with the canonical Zod schema on each protected controller parameter (`@Body`, `@Query`, or `@Param`). It returns the parsed value or throws a Zod error handled by `ProblemExceptionFilter`. The exact HTTP status for malformed requests is an open PRD conflict between PLT-003.AC03 (400) and Appendix F (422); see the implementation status before relying on that status in an API contract.
