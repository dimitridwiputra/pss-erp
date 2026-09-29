'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function KasirProviders({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 15_000 }, mutations: { retry: 0 } },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
