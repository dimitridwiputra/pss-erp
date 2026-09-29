import '@pss/ui/components.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Persetujuan | PSS' };

/**
 * APR-002 is an online-only screen (PRD: "OFFLINE BEHAVIOR: Tidak berlaku"), so this
 * layout only pulls in the shared component styles the inbox and its cards use.
 */
export default function PersetujuanLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
