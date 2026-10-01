import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getPssServerAccessToken } from '../../auth';
import { PssAppShell } from '../_shell/pss-app-shell';
import '@pss/ui/components.css';
import './finance.css';

export default async function FinanceLayout({ children }: { children: ReactNode }) {
  if (!await getPssServerAccessToken()) redirect('/masuk');
  return <PssAppShell>{children}</PssAppShell>;
}
