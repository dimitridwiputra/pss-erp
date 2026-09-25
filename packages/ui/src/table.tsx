import type { ReactNode } from 'react';

export type TableProps = {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  state?: 'default' | 'loading' | 'disabled' | 'error';
  emptyMessage?: string;
};

/** Presentational table only; filtering, sorting, and pagination belong to TanStack Table in an app. */
export function Table({ caption, columns, rows, state = 'default', emptyMessage = 'Belum ada data.' }: TableProps) {
  return (
    <div className={`pss-table-wrap pss-table-state-${state}`}>
      <table className="pss-table">
        <caption>{caption}</caption>
        <thead><tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {state === 'loading' ? <tr><td colSpan={columns.length}>Data sedang dimuat…</td></tr>
            : rows.length === 0 ? <tr><td colSpan={columns.length}>{emptyMessage}</td></tr>
              : rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}
        </tbody>
      </table>
      {state === 'error' && <p className="pss-field-error" role="alert">Data belum dapat dimuat. Coba lagi.</p>}
    </div>
  );
}
