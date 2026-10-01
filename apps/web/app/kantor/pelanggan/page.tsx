import type { Metadata } from 'next';
import { CustomerScreen } from './customer-screen';

export const metadata: Metadata = { title: 'Pelanggan | PSS' };

/** Pelanggan — the customer list (MDM-004) and each customer's PPN switch (TAX-001). */
export default function PelangganPage() {
  return <CustomerScreen />;
}
