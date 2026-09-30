'use client';

import type { CustomerListResponse } from '@pss/contracts';
import { EmptyState, PageHeader, Panel, StatusPill } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { customerStatusLabel } from '../lib/labels';
import { KantorProblem } from '../lib/problem';

const PAGE_SIZE = 25;

/**
 * Pelanggan — look a customer up (MDM-004).
 *
 * **Read-only, and deliberately so.** Registering and reviewing a customer is `createCustomer`'s path
 * with its PENDING_REVIEW state, which the POS quick-register flow uses. This screen exists so an
 * operator can answer "do we know this shop?" while a customer is in front of them; offering an edit
 * here would be a second way to change a customer that no other surface has.
 *
 * The walk-in customer is marked rather than hidden: it is the branch's own system customer, and an
 * operator must not try to charge to it or edit it.
 *
 * `phone` is shown because an operator identifies a customer by it at the counter. It is personal data
 * (AGENTS.md §15) and this screen does nothing else with it.
 */
export function CustomerScreen() {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: 'name' });
  if (query) params.set('q', query);
  if (status) params.set('status', status);

  const list = useQuery({
    queryKey: ['kantor-customers', params.toString()],
    queryFn: () => kasirFetch<CustomerListResponse>(`/master-data/customers?${params}`),
    retry: false,
  });

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <BackofficeFrame title="Pelanggan">
      <PageHeader
        eyebrow="Data Utama"
        title="Pelanggan"
        description="Daftar pelanggan yang sudah terdaftar. Layar ini hanya untuk melihat, bukan untuk mengubah."
      />

      <Panel flush>
        <form
          className="pss-filter-bar"
          role="search"
          onSubmit={(event: FormEvent) => { event.preventDefault(); setPage(1); setQuery(typed.trim()); }}
        >
          <label className="pss-form-field" style={{ margin: 0, flex: 1, minWidth: 220 }}>
            <span className="pss-visually-hidden">Cari kode atau nama pelanggan</span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Cari kode atau nama pelanggan…"
            />
          </label>
          <div className="pss-segmented" role="group" aria-label="Saring keadaan pelanggan">
            {[
              { value: '', label: 'Semua' },
              { value: 'ACTIVE', label: customerStatusLabel.ACTIVE.label },
              { value: 'PENDING_REVIEW', label: customerStatusLabel.PENDING_REVIEW.label },
              { value: 'INACTIVE', label: customerStatusLabel.INACTIVE.label },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={status === option.value}
                className={status === option.value ? 'active' : undefined}
                onClick={() => { setStatus(option.value); setPage(1); }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="submit" className="pss-button pss-button-secondary">Cari</button>
        </form>

        {list.isPending && <span className="pss-skeleton-row" aria-label="Memuat daftar pelanggan" />}
        {list.isError && (
          <KantorProblem
            error={list.error}
            action={<button type="button" className="pss-button pss-button-secondary" onClick={() => void list.refetch()}>Coba Lagi</button>}
          />
        )}
        {list.data && (list.data.items.length === 0
          ? <EmptyState title="Pelanggan tidak ditemukan" description={query ? `Tidak ada pelanggan yang cocok dengan "${query}".` : 'Belum ada pelanggan terdaftar.'} />
          : (
            <>
              <div className="pss-table-scroll">
                <table className="pss-data-table">
                  <thead>
                    <tr><th>Kode</th><th>Nama</th><th>Telepon</th><th>Segmen</th><th>Keadaan</th><th>Dibuat</th></tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((item) => {
                      const state = customerStatusLabel[item.status];
                      return (
                        <tr key={item.customerId}>
                          <td>
                            {item.code}
                            {item.isWalkIn && <small>Pelanggan sistem cabang</small>}
                          </td>
                          <td>{item.name}</td>
                          <td>{item.phone ?? <span className="pss-muted">Tidak ada</span>}</td>
                          <td>{item.segment ?? <span className="pss-muted">—</span>}</td>
                          <td><StatusPill tone={state.tone} label={state.label} /></td>
                          <td>{jakartaDateTime(item.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pss-pagination">
                <span>{list.data.total} pelanggan</span>
                <div>
                  <button type="button" className="pss-button pss-button-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</button>
                  <button type="button" className="pss-button pss-button-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Berikutnya</button>
                </div>
              </div>
            </>
          ))}
      </Panel>
    </BackofficeFrame>
  );
}
