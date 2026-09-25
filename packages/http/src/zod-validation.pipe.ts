import type { PipeTransform } from '@nestjs/common';
import { MalformedRequestError } from '@pss/contracts';
import { z, ZodError } from 'zod';

/** Parse one Nest request value against its canonical @pss/contracts schema. */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      throw new MalformedRequestError(error.issues.map((issue) => ({
        path: issue.path.join('.') || 'input',
        code: issue.code,
        message: 'Periksa nilai ini.',
      })));
    }
  }
}
