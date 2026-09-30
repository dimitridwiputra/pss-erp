import { describe, expect, it } from 'vitest';
import { findCommandFitnessProblems, findPlumbingProblemsIn } from '../scripts/check-command-fitness.mjs';
import { registeredControllerNames } from '../scripts/check-api-controller-registration.mjs';

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

/**
 * AGENTS.md §14 / §3.6. These rules police the transaction plumbing rather than the routes, and
 * each one exists because the shape it rejects was actually present in this repository. A gate
 * nobody has tried to violate is untested, so every rule below is exercised against a violating
 * source as well as a compliant one.
 */
describe('command pipeline is solved once', () => {
  const compliant = `import { runCommand } from '@pss/platform';
    export class Svc {
      async go(pool: Pool, key: CommandKey) {
        return runCommand(pool, key, async ({ client, appendAuditEntry }) => {
          await appendAuditEntry(entry);
          return { code: 200, body: {} };
        });
      }
    }`;

  it('accepts a command that goes through runCommand', () => {
    const { problems, notes } = findPlumbingProblemsIn([{ relative: 'apps/api/src/x.service.ts', source: compliant }]);
    expect(problems).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('rejects reaching for withIdempotentCommand, which makes the audit guarantee opt-in', () => {
    const source = "import { withIdempotentCommand } from '@pss/platform';\nexport const a = withIdempotentCommand;";
    const { problems } = findPlumbingProblemsIn([{ relative: 'apps/api/src/x.ts', source }]);
    expect(problems.join('\n')).toContain('makes the audit guarantee opt-in');
  });

  it('allows the canonical pipeline to call the lower-level primitive', () => {
    const source = "import { withIdempotentCommand } from './idempotency';\nexport const a = withIdempotentCommand;";
    const { problems } = findPlumbingProblemsIn([
      { relative: 'domains/platform/src/application/command.ts', source },
    ]);
    expect(problems).toEqual([]);
  });

  it('rejects a fourth per-domain copy of the audited-transaction helper', () => {
    const source = `import { runAuditedWork, withAuditedTransaction } from '@pss/audit';
      export async function withConnection<T>(pool: Pool, client: PoolClient | undefined, work: (t: AuditedTransaction) => Promise<T>) {
        if (client) return runAuditedWork(client, work);
        return withAuditedTransaction(pool, work);
      }`;
    const { problems } = findPlumbingProblemsIn([
      { relative: 'domains/ar/src/application/support/with-connection.ts', source },
    ]);
    expect(problems.join('\n')).toContain('solved once in @pss/platform');
  });

  it('rejects a local definition as firmly as a local import', () => {
    const source = 'export async function withConnection() { return 1; }';
    const { problems } = findPlumbingProblemsIn([{ relative: 'domains/ar/src/application/x.ts', source }]);
    expect(problems.join('\n')).toContain('solved once in @pss/platform');
  });

  it('requires a stated justification for a command exempt from the audit guard', () => {
    const unjustified = `import { runCommandWithoutAudit } from '@pss/platform';
      export const a = runCommandWithoutAudit(pool, key, work, 'short');`;
    const { problems } = findPlumbingProblemsIn([{ relative: 'apps/api/src/x.ts', source: unjustified }]);
    expect(problems.join('\n')).toContain('without a string-literal justification');
  });

  it('reports a justified exemption instead of rejecting it', () => {
    const justified = `import { runCommandWithoutAudit } from '@pss/platform';
      export const a = runCommandWithoutAudit(pool, key, work,
        'Batch: each confirmation commits independently so one rejected scan becomes NEEDS_REVIEW.');`;
    const { problems, notes } = findPlumbingProblemsIn([{ relative: 'apps/api/src/x.ts', source: justified }]);
    expect(problems).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('NEEDS_REVIEW');
  });

  it('rejects a justification hidden behind an indirection the gate cannot read', () => {
    const indirect = `import { runCommandWithoutAudit } from '@pss/platform';
      async function withoutAudit(reason: string) {
        return runCommandWithoutAudit(pool, key, work, reason);
      }`;
    const { problems } = findPlumbingProblemsIn([{ relative: 'apps/api/src/x.ts', source: indirect }]);
    expect(problems.join('\n')).toContain('without a string-literal justification');
  });
});

describe('PLT-002/PLT-006 command fitness: registered controllers only', () => {
  const unsafe = controllerWith(`      @Post()
      create(@Body() body: unknown) { return body; }`);

  it('inspects a controller once the API module registers it', () => {
    const registered = registeredControllerNames('@Module({ controllers: [HealthController, ThingController] }) class AppModule {}');
    expect(findCommandFitnessProblems([{ fileName: 'thing.ts', source: unsafe }], noExemptions, registered).length).toBeGreaterThan(0);
  });

  it('skips a controller the API module does not register, because it serves no route', () => {
    const registered = registeredControllerNames('@Module({ controllers: [HealthController] }) class AppModule {}');
    expect(findCommandFitnessProblems([{ fileName: 'thing.ts', source: unsafe }], noExemptions, registered)).toEqual([]);
  });

  it('inspects everything when the controllers array cannot be read statically', () => {
    const registered = registeredControllerNames('@Module({ controllers: [...controllers] }) class AppModule {}');
    expect(registered).toBeUndefined();
    expect(findCommandFitnessProblems([{ fileName: 'thing.ts', source: unsafe }], noExemptions, registered).length).toBeGreaterThan(0);
  });
});
