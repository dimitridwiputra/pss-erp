import { z } from 'zod';
import { BusinessDateSchema, MoneyAmountSchema } from '../primitives';

/**
 * Harga — the back office's price list (COM-001).
 *
 * A price change is a **new version**, never an edit in place: COM-001.BR02 and NC01 (an ACTIVE price
 * must not be editable). The flow the screens drive is therefore
 * `createDraftPriceList` → `setPriceListItem` (any number of times) → `activateDraftPriceList`, and
 * `listPriceListItems` shows the draft being edited or the list that is live.
 *
 * `scope` is an opaque string this domain does not interpret (OD-190). POS uses `KONTER`.
 *
 * Money is `numeric(18,2)` on `core.price_list_item.unit_price` and is a decimal string everywhere —
 * never a JSON number, which would round.
 *
 * **No approval step.** COM-001 requires one (`approval.price_list_activation.levels`, and its AC03
 * rejects proposer = approver); the MVP activates directly and records that as MVP-OD-14.
 */

/** `core.price_list.status`. The Harga screen shows a DRAFT as "belum aktif" and never as live. */
export const PriceListStatusSchema = z.enum(['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'EXPIRED']);

/** GET /commercial/price-lists — the versions of one scope, newest first. */
export const PriceListQuerySchema = z.strictObject({
  scope: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PriceListQuery = z.infer<typeof PriceListQuerySchema>;

export const PriceListSummarySchema = z.strictObject({
  priceListId: z.uuid(),
  scope: z.string(),
  status: PriceListStatusSchema,
  version: z.int().positive(),
  validFrom: BusinessDateSchema,
  itemCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const PriceListResponseSchema = z.strictObject({
  items: z.array(PriceListSummarySchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
  /** The scope's live list, so the screen can say what price is in effect right now. */
  activePriceListId: z.uuid().nullable(),
});
export type PriceListResponse = z.infer<typeof PriceListResponseSchema>;

/** POST /commercial/price-lists — a DRAFT, optionally a copy of the version it will supersede. */
export const CreateDraftPriceListRequestSchema = z.strictObject({
  scope: z.string().trim().min(1).max(64),
  validFrom: BusinessDateSchema,
  /** Copy this list's prices into the draft, so a change edits three prices rather than retyping all. */
  copyFromPriceListId: z.uuid().optional(),
});
export type CreateDraftPriceListRequest = z.infer<typeof CreateDraftPriceListRequestSchema>;

export const CreateDraftPriceListResponseSchema = z.strictObject({
  priceListId: z.uuid(),
  scope: z.string(),
  version: z.int().positive(),
  validFrom: BusinessDateSchema,
  itemCount: z.int().nonnegative(),
});
export type CreateDraftPriceListResponse = z.infer<typeof CreateDraftPriceListResponseSchema>;

/** PUT /commercial/price-lists/{id}/items — one product × unit × price on a DRAFT. */
export const SetPriceListItemRequestSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().trim().min(1).max(16),
  /** COM-001 exception flow E1: a price of zero or less is refused. */
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Harga harus angka dengan maksimal 2 desimal.'),
});
export type SetPriceListItemRequest = z.infer<typeof SetPriceListItemRequestSchema>;

export const PriceListItemSchema = z.strictObject({
  priceListItemId: z.uuid(),
  productId: z.uuid(),
  uom: z.string(),
  unitPrice: MoneyAmountSchema,
});
export type PriceListItem = z.infer<typeof PriceListItemSchema>;

export const SetPriceListItemResponseSchema = z.strictObject({
  priceListItemId: z.uuid(),
  priceListId: z.uuid(),
  productId: z.uuid(),
  uom: z.string(),
  unitPrice: MoneyAmountSchema,
  version: z.int().positive(),
});
export type SetPriceListItemResponse = z.infer<typeof SetPriceListItemResponseSchema>;

/**
 * GET /commercial/price-lists/{id}/items.
 *
 * `productId` only, never a product name: `core.product` is `master-data`'s table, and a name read
 * from here would be a cross-domain database read (AGENTS.md §3.1). The API layer joins the two
 * answers through their public APIs, which is where composition belongs.
 */
export const PriceListItemListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  productId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['product', 'unitPrice']).default('product'),
});
export type PriceListItemListQuery = z.infer<typeof PriceListItemListQuerySchema>;

export const PriceListItemListResponseSchema = z.strictObject({
  priceListId: z.uuid(),
  status: PriceListStatusSchema,
  version: z.int().positive(),
  validFrom: BusinessDateSchema,
  items: z.array(PriceListItemSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
});
export type PriceListItemListResponse = z.infer<typeof PriceListItemListResponseSchema>;

/**
 * A price-list row enriched with the product it prices, joined in the API layer from
 * `master-data`'s own read. `sku` and `name` are that domain's facts, carried here only so the
 * Harga screen does not have to make a second round trip per row.
 */
export const PricedProductSchema = z.strictObject({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  baseUom: z.string(),
});
export const PriceListItemWithProductSchema = z.strictObject({
  ...PriceListItemSchema.shape,
  product: PricedProductSchema.nullable(),
});
export const PriceListItemEnrichedResponseSchema = z.strictObject({
  priceListId: z.uuid(),
  status: PriceListStatusSchema,
  version: z.int().positive(),
  validFrom: BusinessDateSchema,
  items: z.array(PriceListItemWithProductSchema),
  page: z.int().positive(),
  pageSize: z.int().positive(),
  total: z.int().nonnegative(),
  hasMore: z.boolean(),
});
export type PriceListItemEnrichedResponse = z.infer<typeof PriceListItemEnrichedResponseSchema>;

/** POST /commercial/price-lists/{id}/activation — publishes a DRAFT. A list with no price is refused. */
export const ActivateDraftPriceListResponseSchema = z.strictObject({
  priceListId: z.uuid(),
  scope: z.string(),
  version: z.int().positive(),
  itemCount: z.int().nonnegative(),
});
export type ActivateDraftPriceListResponse = z.infer<typeof ActivateDraftPriceListResponseSchema>;
