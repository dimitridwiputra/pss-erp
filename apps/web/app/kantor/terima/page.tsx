import type { Metadata } from 'next';
import { ReceiveScreen } from './receive-screen';

export const metadata: Metadata = { title: 'Terima Barang | PSS' };

/** Terima Barang — a goods receipt with a unit cost, without a purchase order (WMS-003, INV-003). */
export default function TerimaBarangPage() {
  return <ReceiveScreen />;
}
