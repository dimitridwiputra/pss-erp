import type { Metadata } from 'next';
import { StockScreen } from './stock-screen';

export const metadata: Metadata = { title: 'Stok | PSS' };

/** Stok — balances with their value, and the movement ledger behind them (INV-001..002). */
export default function StockPage() {
  return <StockScreen />;
}
