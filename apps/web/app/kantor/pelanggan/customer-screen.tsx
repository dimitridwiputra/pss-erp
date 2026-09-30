'use client';

import type { CustomerListResponse } from '@pss/contracts';
import { EmptyState, LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame, BackofficeProblem } from '../../kasir/components/backoffice-frame';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { customerStatusLabel } from '../lib/labels';

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
      <div className="pos-page-heading">
        <div>
          <h1>Pelanggan</h1>
          <p>Daftar pelanggan yang sudah terdaftar. Layar ini hanya untuk melihat.</p>
        </div>
      </div>

      <section className="pos-card">
        <form
          className="pos-toolbar pos-filter-row"
          role="search"
          onSubmit={(event: FormEvent) => { event.preventDefault(); setPage(1); setQuery(typed.trim()); }}
        >
          <label className="pos-search">
            <Search size={17} aria-hidden="true" />
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Cari kode atau nama pelanggan…"
              aria-label="Cari kode atau nama pelanggan"
            />
          </label>
          <span className="pos-filter-label">
            <select
              value={status}
              onChange={(event) => { setStatus(event.target.value); setPage(1); }}
              aria-label="Saring keadaan pelanggan"
            >
              <option value="">Semua keadaan</option>
              <option value="ACTIVE">Aktif</option>
              <option value="PENDING_REVIEW">Menunggu pemeriksaan</option>
              <option value="INACTIVE">Nonaktif</option>
            </select>
          </span>
          <button type="submit" className="pos-outline">Cari</button>
        </form>

        {list.isPending && <LoadingState label="Memuat daftar pelanggan" />}
        {list.isError && <BackofficeProblem error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && (list.data.items.length === 0
          ? <EmptyState title="Pelanggan tidak ditemukan" description={query ? `Tidak ada pelanggan yang cocok dengan "${query}".` : 'Belum ada pelanggan terdaftar.'} />
          : (
            <>
              <div className="pos-table-wrap">
                <table className="pos-table">
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
                          <td><strong>{item.name}</strong></td>
                          <td>{item.phone ?? <span className="pos-muted">Tidak ada</span>}</td>
                          <td>{item.segment ?? <span className="pos-muted">—</span>}</td>
                          <td><span className={`pos-status pos-status-${state.tone}`}>{state.label}</span></td>
                          <td>{jakartaDateTime(item.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pos-pagination">
                <span className="pos-muted">{list.data.total} pelanggan</span>
                <button type="button" className="pos-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Sebelumnya</button>
                <span className="pos-muted">Halaman {page} dari {pages}</span>
                <button type="button" className="pos-outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Berikutnya</button>
              </div>
            </>
          ))}
      </section>
    </BackofficeFrame>
  );
}
