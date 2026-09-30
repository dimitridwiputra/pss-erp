'use client';

import type { CurrentUserPermissionsResponse } from '@pss/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { kasirFetch } from '../kasir/lib/api-client';

/**
 * The warehouse the warehouse screens act on, and the permission codes the viewer holds.
 *
 * The navigation itself is the app shell's (`lib/navigation/work-screens.ts`, served by
 * `/api/experience/shell`); this is the back office's own half: the screens need a `warehouseId` to
 * ask for a balance, and that is not something configuration can supply.
 *
 * **The warehouse list is derived, never configured.** `GET /me/permissions` returns each grant with
 * its scope, so the warehouses a user may act on are the `scopeId`s of their WAREHOUSE-scoped
 * grants. Nothing here reads an environment variable or a lookup table to guess a warehouse, which
 * is what would have made a screen show the wrong stock — and a value is scoped per warehouse
 * (MVP-OD-4), so there is no single right answer to guess.
 *
 * `can()` is here for the screens' own affordances — the "Barang Baru" button, the warehouse picker.
 * It is not the security boundary: every route checks its own permission again on the server.
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

/**
 * The session, or `null` when this component is outside `/kantor`.
 *
 * The provider lives in `app/kantor/layout.tsx`, so a component rendered elsewhere — the Beranda
 * stock widget, which summarises a screen the viewer may open — has no provider above it. That is a
 * normal case, not a mistake, so it is answered with `null` rather than an exception that takes the
 * whole page down.
 */
export function useOptionalKantorSession(): KantorSession | null {
  return useContext(KantorSessionContext);
}

/** The session, for a screen that is inside `/kantor` and is broken without it. */
export function useKantorSession(): KantorSession {
  const session = useOptionalKantorSession();
  if (!session) throw new Error('useKantorSession must be used inside /kantor, which provides KantorSessionProvider.');
  return session;
}
