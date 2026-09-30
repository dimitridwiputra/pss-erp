import '@pss/ui/components.css';
import '../../kasir/pos-design.css';
import '../../kasir/pos-design-mobile.css';
import '../../kasir/styles.css';
import { KasirProviders } from '../../kasir/providers';
import { PenjualanView } from './penjualan-view';

export const metadata = { title: 'Penjualan Konter | PSS' };

export default function PenjualanPage() {
  return <KasirProviders><PenjualanView /></KasirProviders>;
}
