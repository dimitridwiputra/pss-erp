import Link from 'next/link';
import type { ReactNode } from 'react';
import './finance.css';

const navigation = [
  ['Beranda', '/keuangan'], ['Jurnal', '/keuangan/jurnal'], ['Jurnal Manual', '/keuangan/jurnal-manual'],
  ['Buku Besar', '/keuangan/buku-besar'], ['Neraca Saldo', '/keuangan/neraca-saldo'],
  ['Laba Rugi', '/keuangan/laba-rugi'], ['Neraca', '/keuangan/neraca'],
  ['Pengecualian Posting', '/keuangan/pengecualian-posting'], ['Periode', '/keuangan/periode'],
] as const;

export default function FinanceLayout({ children }: { children: ReactNode }) {
  return <div className="finance-shell">
    <aside className="finance-sidebar">
      <p className="finance-brand">PSS <span>KEUANGAN</span></p>
      <nav aria-label="Navigasi keuangan">
        {navigation.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
      </nav>
      <Link className="finance-back" href="/beranda">Kembali ke Beranda</Link>
    </aside>
    <main className="finance-content">{children}</main>
  </div>;
}
