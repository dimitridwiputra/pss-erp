import type { Metadata } from 'next';
import { PriceListScreen } from './price-list-screen';

export const metadata: Metadata = { title: 'Harga Jual | PSS' };

/** Harga Jual — the price list, version by version (COM-001). */
export default function HargaPage() {
  return <PriceListScreen />;
}
