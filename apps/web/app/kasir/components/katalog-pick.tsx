'use client';

import type { KasirKatalogResponse, KasirProductUnitsResponse } from '@pss/contracts';
import { LoadingState } from '@pss/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { kasirFetch } from '../lib/api-client';
import { rupiah } from '../lib/money';
import { ProblemNotice } from './problem-notice';

export interface KatalogPickRequest { productId: string; uom: string }

/**
 * Katalog pick (POS-003, MVP-OD-27): search by name or SKU, open one product, tap the unit to add.
 * Only units with a counter price are offered; the server resolves the name and price again.
 */
export function KatalogPick({ disabled, onPick }: { disabled: boolean; onPick: (request: KatalogPickRequest) => void }) {
  const [search, setSearch] = useState('');
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const term = search.trim();
  const katalog = useQuery({
    queryKey: ['kasir-katalog', term], enabled: term.length >= 2,
    queryFn: () => kasirFetch<KasirKatalogResponse>(`/kasir/products?q=${encodeURIComponent(term)}`),
  });
  const units = useQuery({
    queryKey: ['kasir-product-units', openProductId], enabled: openProductId !== null,
    queryFn: () => kasirFetch<KasirProductUnitsResponse>(`/kasir/products/${openProductId}/units`),
  });

  function pick(request: KatalogPickRequest) {
    onPick(request);
    setSearch('');
    setOpenProductId(null);
  }

  return (
    <>
      <label className="pos-search pos-katalog-search"><Search size={20} />
        <input aria-label="Cari produk" value={search} placeholder="Cari nama atau SKU produk"
          onChange={(event) => { setSearch(event.target.value); setOpenProductId(null); }} />
      </label>
      {katalog.isFetching && <LoadingState label="Mencari produk" rows={2} />}
      {katalog.isError && <ProblemNotice error={katalog.error} />}
      {katalog.data && (katalog.data.items.length === 0
        ? <p className="pos-empty">Produk tidak ditemukan.</p>
        : (
          <ul className="pos-katalog-list">
            {katalog.data.items.map((item) => (
              <li key={item.productId}>
                <button type="button" className="pos-katalog-item" aria-expanded={openProductId === item.productId}
                  onClick={() => setOpenProductId(openProductId === item.productId ? null : item.productId)}>
                  <strong>{item.name}</strong><small>{item.sku}</small>
                </button>
                {openProductId === item.productId && (
                  <div className="pos-katalog-units">
                    {units.isPending && <LoadingState label="Memuat satuan" rows={1} />}
                    {units.isError && <ProblemNotice error={units.error} />}
                    {units.data && units.data.units.length === 0 && <p className="pos-muted">Belum ada harga konter untuk barang ini.</p>}
                    {units.data?.units.map((unit) => (
                      <button key={unit.uom} type="button" className="pos-outline" disabled={disabled}
                        aria-label={`Tambah ${item.name} per ${unit.uom}`}
                        onClick={() => pick({ productId: item.productId, uom: unit.uom })}>
                        <Plus size={18} /> {unit.uom} · {rupiah(unit.unitPrice)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}
