import { notFound } from 'next/navigation';
import { PosPreview } from './pos-preview';
import './styles.css';
import './mobile-home.css';

export const metadata = { title: 'Pratinjau Penjualan POS | PSS' };

export default function PosPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <PosPreview />;
}
