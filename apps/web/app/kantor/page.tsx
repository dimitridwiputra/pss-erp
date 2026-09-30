import type { Metadata } from 'next';
import { DashboardView } from './dashboard-view';

export const metadata: Metadata = { title: 'Dasbor Harian | PSS' };

/** The /kantor home. The shell, the session and the providers are the layout's (apps/web/app/kantor/layout.tsx). */
export default function KantorDashboardPage() {
  return <DashboardView />;
}
