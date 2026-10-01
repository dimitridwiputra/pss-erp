import { CustomerListItemSchema, PriceListStatusSchema, ProductStatusSchema, StockMovementTypeSchema } from '@pss/contracts';
import type { z } from 'zod';

type ProductStatus = z.infer<typeof ProductStatusSchema>;
type PriceListStatus = z.infer<typeof PriceListStatusSchema>;
type StockMovementType = z.infer<typeof StockMovementTypeSchema>;
type CustomerStatus = z.infer<typeof CustomerListItemSchema>['status'];

/**
 * Work-language labels for the /kantor screens. A raw enum value never reaches a screen
 * (AGENTS.md §5, DESIGN_SYSTEM §14.3), and a raw reference-table code never reaches one either: an
 * adjustment reason is shown with the Indonesian label the domain stores beside its code
 * (PRD Appendix F.3).
 *
 * The wording comes from the PRD's own Indonesian, not from this file: product states from the
 * master-data state table (DRAFT → activated by the steward, INACTIVE → nonaktif), the movement
 * types from its inventory glossary (Penerimaan / Pengeluaran / penyesuaian), and the price-list
 * DRAFT from the contract's own note that it is "belum aktif".
 */

/**
 * The design system's tone names, the same ones `StatusPill` takes, so a state and its pill cannot
 * drift apart. The counter's own vocabulary (`green`/`blue`/`yellow`/`red`) is a different set and is
 * not mixed in here.
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const productStatusLabel: Record<ProductStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Belum diaktifkan', tone: 'warning' },
  ACTIVE: { label: 'Aktif', tone: 'success' },
  INACTIVE: { label: 'Nonaktif', tone: 'neutral' },
};

export const orderCaptureLabel: Record<'PSS' | 'EXTERNAL', string> = {
  PSS: 'Dicatat di PSS',
  EXTERNAL: 'Dicatat di sistem lain',
};

export const priceListStatusLabel: Record<PriceListStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Belum aktif', tone: 'warning' },
  PENDING_APPROVAL: { label: 'Menunggu persetujuan', tone: 'warning' },
  SCHEDULED: { label: 'Terjadwal', tone: 'info' },
  ACTIVE: { label: 'Harga aktif', tone: 'success' },
  EXPIRED: { label: 'Kedaluwarsa', tone: 'neutral' },
};

export const movementTypeLabel: Record<StockMovementType, { label: string; tone: Tone }> = {
  RECEIVE: { label: 'Penerimaan', tone: 'success' },
  ISSUE: { label: 'Pengeluaran', tone: 'info' },
  ADJUSTMENT: { label: 'Penyesuaian', tone: 'warning' },
};

export const customerStatusLabel: Record<CustomerStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draf', tone: 'neutral' },
  PENDING_REVIEW: { label: 'Menunggu pemeriksaan', tone: 'warning' },
  ACTIVE: { label: 'Aktif', tone: 'success' },
  INACTIVE: { label: 'Nonaktif', tone: 'neutral' },
  MERGED: { label: 'Digabung', tone: 'neutral' },
};

/** "Aktif" for a live list, and a way past the current one. Never a bare version number. */
export function priceListHeading(scope: string, version: number, status: PriceListStatus): string {
  const state = priceListStatusLabel[status];
  return `${scope} · versi ${version} · ${state.label.toLowerCase()}`;
}

/** A cost that was never given. Never a zero rupiah: the number would read as "free". */
export const NO_COST = 'belum ada harga pokok';

/** The screen's own copy for a value the domain reports as null. */
export const NO_VALUE = 'belum ada nilai';
