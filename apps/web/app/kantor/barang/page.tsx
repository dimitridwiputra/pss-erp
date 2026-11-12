import type { Metadata } from 'next';
import { ProductScreen } from './product-screen';

export const metadata: Metadata = { title: 'Barang | PSS' };

/** Barang — the back office's product master (MDM-001..003). */
export default function BarangPage() {
  return <ProductScreen />;
}
