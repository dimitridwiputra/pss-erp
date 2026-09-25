import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/** Parse one Nest request value against its canonical @pss/contracts schema. */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    return this.schema.parse(value);
  }
}
