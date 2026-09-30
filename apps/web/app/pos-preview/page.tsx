import { notFound } from 'next/navigation';
import { PosPreview } from './pos-preview';
// The design lives with the production screen that uses it, /kasir.
import '../kasir/pos-design.css';
import '../kasir/pos-design-mobile.css';

export const metadata = { title: 'Pratinjau Penjualan POS | PSS' };

export default function PosPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <PosPreview />;
}
