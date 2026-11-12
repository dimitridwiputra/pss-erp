import type { Metadata } from 'next';
import { themeBootScript } from '@pss/ui';
import '@pss/ui/tokens.css';
import './styles.css';

export const metadata: Metadata = {
  title: 'PSS Operating Platform',
  description: 'Platform operasional Putra Sumber Sari',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The theme attribute is set before paint by the boot script, so React must not warn about it.
    <html lang="id" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
