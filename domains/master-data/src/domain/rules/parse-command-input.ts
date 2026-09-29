import { z, ZodError } from 'zod';
import { DomainError } from '@pss/contracts';

/** Validates one application command/query's input the same way the HTTP edge does (packages/http/src/zod-validation.pipe.ts). */
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
