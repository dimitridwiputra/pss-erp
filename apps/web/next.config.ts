import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

/**
 * Client-side fetches (`kasirFetch`, `gudangFetch`) call bare relative paths like `/pos/shifts` so
 * they work unmodified behind a shared-origin production gateway; in local dev there is no such
 * gateway, so proxy those same prefixes straight to the NestJS API. `:path+` (one or more
 * segments) rather than `:path*` deliberately excludes the bare `/kasir` and `/gudang` routes
 * themselves, which are this app's own pages, not API calls.
 */
async function rewrites() {
  const apiBaseUrl = process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000';
  return [
    ...['pos', 'kasir', 'wms', 'gudang'].map((prefix) => ({
      source: `/${prefix}/:path+`,
      destination: `${apiBaseUrl}/${prefix}/:path+`,
    })),
    { source: '/me', destination: `${apiBaseUrl}/me` },
    { source: '/me/:path+', destination: `${apiBaseUrl}/me/:path+` },
  ];
}

const config: NextConfig = { output: 'standalone', logging: { incomingRequests: false }, rewrites };
export default withSerwist(config);
