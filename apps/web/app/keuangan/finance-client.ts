'use client';

import { useEffect, useState } from 'react';

export function useFinanceData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/bff/finance/${path}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Data keuangan belum dapat dimuat. Coba lagi atau hubungi admin.');
        return response.json() as Promise<T>;
      })
      .then((value) => setData(value))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Data belum dapat dimuat.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path]);
  return { data, error, loading };
}

export function useFinancePermissions() {
  const [permissions, setPermissions] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/bff/core/me/permissions', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ grants: Array<{ permission: string }> }> : { grants: [] })
      .then((value) => setPermissions(value.grants.map((grant) => grant.permission)))
      .catch(() => { if (!controller.signal.aborted) setPermissions([]); });
    return () => controller.abort();
  }, []);
  return permissions;
}

export function rupiah(value: string | number) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 2 }).format(Number(value));
}

export function financeDate(value: string) {
  return value.slice(0, 10);
}

export function periodLabel(status: string) {
  return ({ OPEN: 'Terbuka', SOFT_CLOSED: 'Tutup sementara', CLOSED: 'Ditutup' } as Record<string, string>)[status] ?? 'Perlu dicek';
}

export function journalLabel(status: string) {
  return ({ DRAFT: 'Draf', PENDING_APPROVAL: 'Menunggu persetujuan', POSTED: 'Dibukukan', REVERSED: 'Dibalik' } as Record<string, string>)[status] ?? 'Perlu dicek';
}
