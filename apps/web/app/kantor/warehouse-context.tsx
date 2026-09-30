'use client';

import type { CurrentUserPermissionsResponse } from '@pss/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { kasirFetch } from '../kasir/lib/api-client';

/**
 * The session facts every /kantor screen needs: which permission codes it holds, and which
 * warehouses it may act on. One read of `/me/permissions` answers both, and every screen shares the
 * same TanStack Query key, so the shell, the navigation and the stock screens cost one round trip.
 *
 * **The warehouse list is derived, never configured.** `GET /me/permissions` returns each grant with
 * its scope, so the warehouses a user may post to are the `scopeId`s of their WAREHOUSE-scoped
 * grants. Nothing here reads an environment variable or a lookup table to guess a warehouse, which
 * is what would have made a demo screen show the wrong stock.
 */

const STORAGE_KEY = 'pss-kantor-warehouse';

export interface KantorSession {
  /** True while `/me/permissions` has not answered. */
  readonly pending: boolean;
  readonly permissions: ReadonlySet<string>;
  readonly warehouseIds: readonly string[];
  /** The warehouse the stock screens act on, or null when there is none to choose from. */
  readonly warehouseId: string | null;
  setWarehouseId: (warehouseId: string) => void;
  /** A permission-code test (RBAC-001.R02), for deciding what a screen may show. */
  can: (permission: string) => boolean;
}

const KantorSessionContext = createContext<KantorSession | null>(null);

/** The choice survives a reload so an operator does not re-pick the warehouse on every screen. */
function readStoredWarehouse(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? null;
  } catch {
    // A browser with storage disabled still works; the picker just starts empty each time.
    return null;
  }
}

export function KantorSessionProvider({ children }: { children: ReactNode }) {
  const permissions = useQuery({
    queryKey: ['kantor-permissions'],
    queryFn: () => kasirFetch<CurrentUserPermissionsResponse>('/me/permissions'),
    staleTime: 300_000,
    retry: false,
  });
  const [chosen, setChosen] = useState<string | null>(null);

  const granted = useMemo(
    () => new Set(permissions.data?.grants.map((grant) => grant.permission) ?? []),
    [permissions.data],
  );
  const warehouseIds = useMemo(
    () => [...new Set((permissions.data?.grants ?? [])
      .filter((grant) => grant.scopeType === 'WAREHOUSE' && grant.scopeId)
      .map((grant) => grant.scopeId as string))]
      .sort(),
    [permissions.data],
  );

  // A stored warehouse that is no longer in scope is dropped rather than shown: it would 404 on the
  // stock reads and read as "no stock" instead of "no access".
  const warehouseId = useMemo(() => {
    if (chosen && warehouseIds.includes(chosen)) return chosen;
    if (warehouseIds.length === 1) return warehouseIds[0] ?? null;
    return null;
  }, [chosen, warehouseIds]);

  useEffect(() => {
    if (!warehouseIds.length) return;
    const stored = readStoredWarehouse();
    if (stored && warehouseIds.includes(stored)) setChosen(stored);
  }, [warehouseIds]);

  const value = useMemo<KantorSession>(() => ({
    // `pending` covers the read *and* its failure. A caller must not be able to tell "we do not know
    // yet" from "you have none", because the second is a statement about the person and the first is
    // a statement about the network.
    pending: permissions.isPending || permissions.isError,
    permissions: granted,
    warehouseIds,
    warehouseId,
    setWarehouseId: (next) => {
      setChosen(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Nothing to do: the choice still holds for this page view.
      }
    },
    can: (permission) => granted.has(permission),
  }), [permissions.isPending, permissions.isError, granted, warehouseIds, warehouseId]);

  return <KantorSessionContext.Provider value={value}>{children}</KantorSessionContext.Provider>;
}

export function useKantorSession(): KantorSession {
  const session = useContext(KantorSessionContext);
  if (!session) throw new Error('useKantorSession must be used inside KantorSessionProvider.');
  return session;
}
