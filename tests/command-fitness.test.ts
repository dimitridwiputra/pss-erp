import { describe, expect, it } from 'vitest';
import { findCommandFitnessProblems } from '../scripts/check-command-fitness.mjs';

const noExemptions = { exemptions: [] };

function controllerWith(body: string): string {
  return `
    import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
    import { ZodValidationPipe, readIdempotencyKey } from '@pss/http';
    import { z } from 'zod';

    const Schema = z.strictObject({ reason: z.string() });

    @Controller('things')
    export class ThingController {
      @Get(':id')
      read(@Param('id') id: string) { return id; }

${body}
    }
  `;
}

const guarded = `      @Post(':id/action')
      action(@Req() request: { headers: { authorization?: string } }, @Param('id') id: string, @Body(new ZodValidationPipe(Schema)) body: { reason: string }) {
        const key = readIdempotencyKey(request as never);
        return { user: this.currentUser(request), id, body, key };
      }

      private currentUser(request: { headers: { authorization?: string } }) {
        return request.headers.authorization;
      }`;

describe('PLT-002/PLT-006 command fitness', () => {
  it('accepts a mutating route that resolves its caller, validates its body, and reads an idempotency key', () => {
    expect(findCommandFitnessProblems([{ fileName: 'thing.ts', source: controllerWith(guarded) }], noExemptions)).toEqual([]);
  });

  it('ignores read routes, which mutate nothing', () => {
    const problems = findCommandFitnessProblems([{ fileName: 'thing.ts', source: controllerWith(guarded) }], noExemptions);
    expect(problems.join('\n')).not.toContain('@Get');
  });

  it('PLT-006.AC02 rejects a mutating route with no Idempotency-Key', () => {
    const missingKey = guarded.replace("const key = readIdempotencyKey(request as never);", "const key = null;");
    const problems = findCommandFitnessProblems([{ fileName: 'thing.ts', source: controllerWith(missingKey) }], noExemptions);
    expect(problems.join('\n')).toContain('Idempotency-Key');
  });

  it('rejects a mutating route that trusts the body instead of the Authorization header', () => {
    const trustsBody = guarded.replace("user: this.currentUser(request),", "user: body,");
    const problems = findCommandFitnessProblems([{ fileName: 'thing.ts', source: controllerWith(trustsBody) }], noExemptions);
    expect(problems.join('\n')).toContain('does not resolve the acting user');
  });

  it('rejects a raw @Body that no Zod schema validates', () => {
    const rawBody = guarded.replace('@Body(new ZodValidationPipe(Schema))', '@Body()');
    const problems = findCommandFitnessProblems([{ fileName: 'thing.ts', source: controllerWith(rawBody) }], noExemptions);
    expect(problems.join('\n')).toContain('unvalidated @Body');
  });

  it('honours a reviewed exemption but not one without a stated reason', () => {
    const route = 'POST /things/:id/action';
    const withExemption = findCommandFitnessProblems(
      [{ fileName: 'thing.ts', source: controllerWith(guarded.replace("const key = readIdempotencyKey(request as never);", "const key = null;")) }],
      { exemptions: [{ method: 'POST', path: '/things/:id/action', rule: 'idempotency', reason: 'Row-locked and rejected on replay.' }] },
    );
    expect(withExemption).toEqual([]);

    const withoutReason = findCommandFitnessProblems(
      [{ fileName: 'thing.ts', source: controllerWith(guarded.replace("const key = readIdempotencyKey(request as never);", "const key = null;")) }],
      { exemptions: [{ method: 'POST', path: route, rule: 'idempotency' }] },
    );
    expect(withoutReason.join('\n')).toContain('Malformed exemption entry');
  });

  it('does not let a comment satisfy a requirement', () => {
    const commented = guarded.replace('const key = readIdempotencyKey(request as never);', '// readIdempotencyKey(request) was removed here.');
    const problems = findCommandFitnessProblems([{ fileName: 'thing.ts', source: controllerWith(commented) }], noExemptions);
    expect(problems.join('\n')).toContain('Idempotency-Key');
  });
});
