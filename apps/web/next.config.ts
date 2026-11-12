import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

/**
 * `gudangFetch` calls bare relative paths like `/wms/tasks`; in local dev there is no shared-origin
 * gateway, so proxy those prefixes straight to the NestJS API. `:path+` (one or more segments)
 * rather than `:path*` deliberately excludes the bare `/gudang` route, which is this app's own page.
 * Kasir traffic does not come through here: `kasirFetch` uses the server-side BFF proxy
 * (`app/api/bff/**`, `lib/bff/proxy.ts`), so a rewrite would only be a second, unguarded path.
 */
async function rewrites() {
  const apiBaseUrl = process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000';
  return [
    ...['wms', 'gudang'].map((prefix) => ({
      source: `/${prefix}/:path+`,
      destination: `${apiBaseUrl}/${prefix}/:path+`,
    })),
    { source: '/me', destination: `${apiBaseUrl}/me` },
    { source: '/me/:path+', destination: `${apiBaseUrl}/me/:path+` },
  ];
}

const config: NextConfig = { output: 'standalone', logging: { incomingRequests: false }, rewrites };
export default withSerwist(config);
