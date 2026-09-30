import type { Metadata } from 'next';
import { CustomerScreen } from './customer-screen';

export const metadata: Metadata = { title: 'Pelanggan | PSS' };

/** Pelanggan — the read-only customer list (MDM-004). */
export default function PelangganPage() {
  return <CustomerScreen />;
}
