import type { Metadata } from 'next';
import { AdjustmentScreen } from './adjustment-screen';

export const metadata: Metadata = { title: 'Penyesuaian Stok | PSS' };

/** Penyesuaian Stok — correct a balance, always with a registered reason (INV-004..006). */
export default function PenyesuaianStokPage() {
  return <AdjustmentScreen />;
}
