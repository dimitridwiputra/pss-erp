import '@pss/ui/components.css';
import './pos-design.css';
import './pos-design-mobile.css';
import './styles.css';
import type { ReactNode } from 'react';
import { KasirProviders } from './providers';

export const metadata = { title: 'PSS Kasir' };

/**
 * No client-side gate here: whether the counter exists is the API's decision (MVP-OD-5,
 * `PSS_DEMO_POS_ENABLED`), and the screen renders its FEATURE_DISABLED answer as a state.
 */
export default function KasirLayout({ children }: { children: ReactNode }) {
  return <KasirProviders>{children}</KasirProviders>;
}
