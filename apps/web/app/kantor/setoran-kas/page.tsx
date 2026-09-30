import '@pss/ui/components.css';
import '../../kasir/pos-design.css';
import '../../kasir/pos-design-mobile.css';
import '../../kasir/styles.css';
import { KasirProviders } from '../../kasir/providers';
import { SetoranKasView } from './setoran-kas-view';

export const metadata = { title: 'Setoran Kas | PSS' };

export default function SetoranKasPage() {
  return <KasirProviders><SetoranKasView /></KasirProviders>;
}
