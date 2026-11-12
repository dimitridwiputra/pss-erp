'use client';

import type { CustomerListResponse, SetCustomerTaxTreatmentResponse } from '@pss/contracts';
import { EmptyState, PageHeader, Panel, StatusPill } from '@pss/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { BackofficeFrame } from '../../kasir/components/backoffice-frame';
import { useCommand } from '../../kasir/hooks/use-command';
import { kasirFetch } from '../../kasir/lib/api-client';
import { jakartaDateTime } from '../../kasir/lib/labels';
import { customerStatusLabel, salesTaxCodeLabel, TAX_UNSET } from '../lib/labels';
import { KantorProblem } from '../lib/problem';

const PAGE_SIZE = 25;

/**
 * Pelanggan — look a customer up (MDM-004).
 *
 * **Read-only, except for PPN.** Registering and reviewing a customer is `createCustomer`'s path
 * with its PENDING_REVIEW state, which the POS quick-register flow uses. This screen exists so an
 * operator can answer "do we know this shop?" while a customer is in front of them. The one thing it
 * changes is whether a customer is charged PPN (TAX-001), because that is decided per customer and
 * has no other screen; it applies to sales made afterwards, never to an existing invoice.
 *
 * The walk-in customer is marked rather than hidden: it is the branch's own system customer. Its PPN
 * switch is the counter's — every walk-in sale at the branch follows it.
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
        description="Daftar pelanggan yang sudah terdaftar. Di sini Anda juga mengatur apakah penjualan ke pelanggan dikenai PPN."
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
                    <tr><th>Kode</th><th>Nama</th><th>Telepon</th><th>Segmen</th><th>Keadaan</th><th>PPN</th><th>Dibuat</th></tr>
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
                          <td><TaxTreatmentToggle customer={item} /></td>
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

type CustomerRow = CustomerListResponse['items'][number];

/**
 * PPN on or off for one customer. Two plain choices rather than the three tax codes: "Bebas PPN"
 * (EXEMPT) is shown when it is stored, but setting it is a tax decision for Finance, not this screen.
 * The wording comes from `lib/labels`, shared with the product form, so the two screens cannot drift.
 * A customer with no treatment yet shows neither choice pressed, and says why a sale to them stops.
 */
function TaxTreatmentToggle({ customer }: { customer: CustomerRow }) {
  const queryClient = useQueryClient();
  const set = useCommand(
    (taxTreatment: 'VAT_OUTPUT' | 'NON_VAT', key) => kasirFetch<SetCustomerTaxTreatmentResponse>(
      `/master-data/customers/${customer.customerId}/tax-treatment`,
      { method: 'PUT', idempotencyKey: key, body: JSON.stringify({ taxTreatment, expectedVersion: customer.version }) },
    ),
    { onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['kantor-customers'] }); } },
  );
  const current = customer.taxTreatment;
  const options = [
    { value: 'VAT_OUTPUT', label: salesTaxCodeLabel.VAT_OUTPUT },
    { value: 'NON_VAT', label: salesTaxCodeLabel.NON_VAT },
  ] as const;
  return (
    <div>
      <div className="pss-segmented" role="group" aria-label={`PPN untuk ${customer.name}`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={current === option.value}
            className={current === option.value ? 'active' : undefined}
            disabled={set.isPending}
            onClick={() => { if (current !== option.value) set.mutate(option.value); }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {current === 'EXEMPT' && <small>Saat ini: {salesTaxCodeLabel.EXEMPT}</small>}
      {current === null && <small>{TAX_UNSET} — penjualan ke pelanggan ini akan ditolak.</small>}
      {set.isError && <KantorProblem error={set.error} />}
    </div>
  );
}
