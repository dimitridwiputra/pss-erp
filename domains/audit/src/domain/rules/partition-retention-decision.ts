import type { AuditArchivePageReceipt } from '../audit-archive';

/**
 * OD-19: "A partition is dropped only after its rows are archived and only when every row in it is
 * past the period for its class — never on a clock alone."
 *
 * That sentence is two conditions and a prohibition, and the prohibition is the one a calendar
 * invites you to break. A monthly partition whose month has passed its window looks droppable from
 * the outside even when one row inside it is still inside its class period, and `DROP TABLE` is the
 * most destructive statement this domain can run. So the whole proof lives in one pure function, and
 * the strongest condition is evaluated first:
 *
 *   1. any row still inside its class period -> hold, whatever the archive says;
 *   2. any page the archive did not confirm -> hold;
 *   3. no receipt at all                    -> hold, a partition is never dropped unarchived;
 *   4. a receipt for a different partition -> hold;
 *   5. the archived row count not equal to the counted row count -> hold.
 *
 * Condition 1 is checked before any archive result on purpose. A fully confirmed archive must not be
 * able to release a partition that still owes hot retention: the archive is a copy, and the primary
 * database is where the record is still in force.
 */
export type PartitionHoldReason =
  | 'ROWS_INSIDE_HOT_PERIOD'
  | 'ARCHIVE_RECEIPT_MISMATCH'
  | 'ARCHIVE_NOT_ATTEMPTED';

/** What the domain sent for one page and what the archive answered. */
export interface PartitionPageAttempt {
  pageIndex: number;
  /** Rows the domain read and handed to the archive. */
  rows: number;
  /** Digest the domain computed over the page it sent. */
  expectedDigest: string;
  /** Cursor the domain sent, so a receipt for a different page cannot be counted as this one. */
  cursor: string;
  receipt: AuditArchivePageReceipt | null;
}

export type PartitionDisposition =
  | { outcome: 'ARCHIVE_AND_DROP'; rows: number; pages: number }
  | { outcome: 'HOLD'; reason: PartitionHoldReason; detail: string };

export interface PartitionDispositionInput {
  partition: string;
  /** Rows the partition held when it was counted, before any page was sent. */
  totalRows: number;
  /** Rows inside a hot window, summed over every class present in the partition. */
  rowsInsideHotPeriod: number;
  /** Every page the domain attempted, in order. Empty means the archive was never called. */
  attempts: readonly PartitionPageAttempt[];
}

export function decidePartitionDisposition(input: PartitionDispositionInput): PartitionDisposition {
  if (input.rowsInsideHotPeriod > 0) {
    return {
      outcome: 'HOLD',
      reason: 'ROWS_INSIDE_HOT_PERIOD',
      detail: `${input.rowsInsideHotPeriod} row(s) are still inside their class's hot window.`,
    };
  }
  // An empty partition is released without an archive call. There is nothing to copy, so demanding a
  // receipt would only mean the partition set grows one dead relation for every month that happened
  // to record nothing. Keying on `totalRows` rather than on `attempts.length` is what keeps this from
  // becoming a hole: a partition that holds rows still needs a confirmed page.
  if (input.totalRows === 0) {
    return { outcome: 'ARCHIVE_AND_DROP', rows: 0, pages: 0 };
  }
  if (input.attempts.length === 0) {
    return { outcome: 'HOLD', reason: 'ARCHIVE_NOT_ATTEMPTED', detail: 'No page of this partition was archived.' };
  }
  for (const attempt of input.attempts) {
    const { receipt } = attempt;
    if (receipt === null) {
      return { outcome: 'HOLD', reason: 'ARCHIVE_RECEIPT_MISMATCH', detail: `Page ${attempt.pageIndex} was not acknowledged.` };
    }
    if (receipt.partition !== input.partition) {
      return {
        outcome: 'HOLD',
        reason: 'ARCHIVE_RECEIPT_MISMATCH',
        detail: `Page ${attempt.pageIndex} was acknowledged for ${receipt.partition}, not ${input.partition}.`,
      };
    }
    if (receipt.cursor !== attempt.cursor) {
      return {
        outcome: 'HOLD',
        reason: 'ARCHIVE_RECEIPT_MISMATCH',
        detail: `Page ${attempt.pageIndex} was acknowledged under cursor ${receipt.cursor}.`,
      };
    }
    if (receipt.rows !== attempt.rows) {
      return {
        outcome: 'HOLD',
        reason: 'ARCHIVE_RECEIPT_MISMATCH',
        detail: `Page ${attempt.pageIndex} stored ${receipt.rows} row(s) for the ${attempt.rows} that were sent.`,
      };
    }
    if (receipt.digest !== attempt.expectedDigest) {
      return {
        outcome: 'HOLD',
        reason: 'ARCHIVE_RECEIPT_MISMATCH',
        detail: `Page ${attempt.pageIndex} came back with a digest that is not the digest of the page that was sent.`,
      };
    }
  }
  const archivedRows = input.attempts.reduce((sum, attempt) => sum + attempt.rows, 0);
  if (archivedRows !== input.totalRows) {
    return {
      outcome: 'HOLD',
      reason: 'ARCHIVE_RECEIPT_MISMATCH',
      detail: `Archived ${archivedRows} row(s) of the ${input.totalRows} the partition holds.`,
    };
  }
  return { outcome: 'ARCHIVE_AND_DROP', rows: input.totalRows, pages: input.attempts.length };
}
