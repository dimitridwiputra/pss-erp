# @pss/offline

IndexedDB-backed offline queue for PSS Kasir (POS-013), built on [Dexie](https://dexie.org). Holds a per-shift cached product catalog, the local pending-sale queue, and cached shift state — all scoped to one browser/device, matching PLT-013's "local queue survives restart, encrypted at rest, cleared on forced logout" requirement (encryption-at-rest is the caller's responsibility, e.g. wrapping values with the Web Crypto API before writing — this package stores plain records).

No server calls happen here except `syncPosOfflineBatch`, which POSTs the queued batch to a caller-supplied endpoint (`/kasir/sync`) and reconciles the response back into local state. No business rules live in this package (AGENTS.md §7); it is a plain client-side queue/sync mechanism.
