import { z, ZodError } from 'zod';
import { DomainError } from './api/problem';

/**
 * Validates one application command's or query's input, and reports a failure the way the platform
 * reports every other problem: a `DomainError` with one field error per issue, so a form can point at
 * the field that is wrong instead of showing a stack trace or a bare 500.
 *
 * This is the domain-layer twin of the HTTP edge's `ZodValidationPipe` in `@pss/http`. Both exist
 * because a command is also called from another domain's application code, from a worker, and from a
 * seed, where there is no request to validate. The copy that lived in `domains/master-data` is
 * replaced by this one; `domains/wms` carries its own because it is frozen for the MVP.
 *
 * The message is a fixed Indonesian string rather than Zod's, because Zod's default text is English
 * and backend jargon (UX-10: "Kompleksitas backend tidak boleh bocor ke frontend"). A schema that
 * needs to say something specific puts it in its own domain rule, which can throw a `DomainError`
 * with a field-level message.
 */
export function parseCommandInput<TSchema extends z.ZodType>(schema: TSchema, rawInput: unknown): z.output<TSchema> {
  try {
    return schema.parse(rawInput);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new DomainError('VALIDATION_FAILED', [], error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
}
