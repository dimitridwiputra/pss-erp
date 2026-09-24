import type { Metadata } from 'next';
import '@pss/ui/tokens.css';
import './styles.css';

export const metadata: Metadata = {
  title: 'PSS Operating Platform',
  description: 'Platform operasional Putra Sumber Sari',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="id"><body>{children}</body></html>;
}
