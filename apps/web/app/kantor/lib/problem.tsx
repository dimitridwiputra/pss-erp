'use client';

import type { ProblemDetails } from '@pss/contracts';
import type { ReactNode } from 'react';
import { KasirApiError } from '../../kasir/lib/api-client';
import { ProblemNotice } from '../../kasir/components/problem-notice';

/**
 * The refusal notice for a /kantor form.
 *
 * The counter's own callout, which the shell keeps available inside `BackofficeFrame`
 * (`app/kantor/kantor.css`), so a refusal reads the same on the counter and in the back office.
 *
 * **A field's own sentence is the headline when there is one.** The registry's copy for a code is
 * written for the area that code belongs to, and the area can be the wrong one: `DUPLICATE_CODE`'s
 * registered explanation is "Pilih kode cabang lain", because the PRD wrote it for a duplicate branch
 * code. Shown above a barcode field it tells the operator to choose a different *branch code* — the
 * wrong instruction, from the right sentence.
 *
 * `addProductBarcode` answers a duplicate with a field message naming the code and saying what to do
 * instead. That message is the one the operator can act on, so it leads; the registry's title stays
 * as the heading, and the full problem is still behind the disclosure for support. With no field
 * message — a refusal of the whole request — the shared notice is used unchanged.
 */
export function KantorProblem({ error, action }: { error: unknown; action?: ReactNode }) {
  const problem = error instanceof KasirApiError ? error.problem : null;
  const field = singleFieldMessage(problem);
  if (!problem || field === null) return <ProblemNotice error={error} {...(action ? { action } : {})} />;

  return (
    <div className="pos-callout pos-callout-danger" role="alert">
      <strong>{problem.title}</strong>
      <p>{field}</p>
      {action}
      {problem.requestId && (
        <details>
          <summary>Rincian untuk bantuan</summary>
          <p>Kode bantuan: {problem.requestId}</p>
        </details>
      )}
    </div>
  );
}

/** The one field message, or null when there is not exactly one. */
function singleFieldMessage(problem: ProblemDetails | null): string | null {
  const messages = [...new Set((problem?.fieldErrors ?? []).map((field) => field.message.trim()).filter(Boolean))];
  return messages.length === 1 ? messages[0] ?? null : null;
}
