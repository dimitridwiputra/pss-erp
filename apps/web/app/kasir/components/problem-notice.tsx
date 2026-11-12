'use client';

import type { ReactNode } from 'react';
import { KasirApiError } from '../lib/api-client';

/**
 * UX-06: an actionable error with the server's registered Indonesian copy. Field errors are listed
 * by their own message; the request id is behind a disclosure for support, never the headline.
 */
export function ProblemNotice({ error, action }: { error: unknown; action?: ReactNode }) {
  if (!error) return null;
  const problem = error instanceof KasirApiError ? error.problem : null;
  const title = problem?.title ?? 'Koneksi terputus';
  const message = problem?.message ?? (error instanceof Error ? error.message : 'Coba lagi sebentar lagi.');
  const fields = problem?.fieldErrors?.map((field) => field.message).filter((text) => text && text !== message) ?? [];
  return (
    <div className="pos-callout pos-callout-danger" role="alert">
      <strong>{title}</strong>
      <p>{message}</p>
      {fields.length > 0 && <ul>{[...new Set(fields)].map((text) => <li key={text}>{text}</li>)}</ul>}
      {action}
      {problem?.requestId && <details><summary>Rincian untuk bantuan</summary><p>Kode bantuan: {problem.requestId}</p></details>}
    </div>
  );
}
