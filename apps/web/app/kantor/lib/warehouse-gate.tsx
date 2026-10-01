'use client';

import { EmptyState, LoadingState } from '@pss/ui';
import type { ReactNode } from 'react';
import { useKantorSession } from '../warehouse-context';

/**
 * The gate every warehouse-scoped screen stands behind.
 *
 * **"Still loading" and "you have no warehouse" must never look the same.** The first is a statement
 * about the network and the second is a statement about the person; collapsing them would tell an
 * operator their account is wrong while the read is still in flight, and the stock screens would show
 * an empty shelf for a warehouse that is about to appear.
 *
 * So three states, in the operator's language: loading, no scope, and the screen itself.
 */
export function WarehouseGate({ children }: { children: (warehouseId: string) => ReactNode }) {
  const { warehouseId, warehouseIds, pending } = useKantorSession();

  if (pending) return <LoadingState label="Memuat cakupan gudang" rows={2} />;

  if (!warehouseId) {
    return (
      <EmptyState
        title="Belum ada gudang yang bisa dipilih"
        description="Akun Anda tidak punya cakupan gudang, jadi layar ini tidak dapat menampilkan apa pun. Hubungi administrator bila ini tidak sesuai."
      />
    );
  }

  // More than one warehouse in scope and none chosen yet: the picker is the choice, and a screen
  // that guessed one would be showing another branch's stock.
  if (warehouseIds.length > 1) {
    return (
      <EmptyState
        title="Pilih gudang dulu"
        description="Akun Anda punya beberapa gudang. Pilih salah satu di kotak Gudang di sisi kiri, lalu layar ini akan menampilkannya."
      />
    );
  }

  return <>{children(warehouseId)}</>;
}
