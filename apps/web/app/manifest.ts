import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PSS Kasir',
    short_name: 'PSS Kasir',
    description: 'Konter penjualan grosir PSS — bekerja offline, sinkron otomatis saat online.',
    start_url: '/kasir',
    scope: '/kasir',
    display: 'standalone',
    orientation: 'any',
    background_color: '#F6F5F0',
    theme_color: '#0A2359',
    icons: [
      { src: '/pss-logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pss-logo.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
