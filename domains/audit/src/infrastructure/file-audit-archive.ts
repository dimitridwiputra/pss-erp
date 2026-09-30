import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  auditArchiveDigest,
  type AuditArchive,
  type AuditArchiveEntry,
  type AuditArchivePage,
  type AuditArchivePageReceipt,
  type AuditArchiveReader,
} from '../domain/audit-archive';

/**
 * A filesystem archive client, and the reader that goes with it.
 *
 * This is a real implementation, not a stub: it writes real NDJSON bytes to a real directory and
 * reads them back. It is deliberately local, because the point of the archive contract is that the
 * retention rule can be exercised end to end — archive, drop, restore, verify — without a cloud
 * account in the loop. What it is NOT is production storage: a local directory is not independent of
 * the host, so this cannot satisfy the owner condition that rotation only runs where the archive
 * outlives the primary database. `docs/runbooks/audit-archive-restore.md` says so in the same words,
 * and the scheduler stays disabled while this is the registered client.
 *
 * The write is atomic. A page is written to a temporary file in the same directory and renamed into
 * place, so a crash mid-write leaves no object rather than a truncated one. That matters more than it
 * looks: a truncated NDJSON file whose last line is cut in half is still readable, still parses as
 * every complete line it does have, and would restore as a plausible-looking archive that is quietly
 * missing rows. Writing a manifest whose digest covers the whole object makes that detectable, but
 * only if the manifest is not itself half-written — hence rename rather than two writes.
 */
export class FileAuditArchive implements AuditArchive, AuditArchiveReader {
  constructor(private readonly root: string) {}

  /**
   * Page object names are derived from the partition and cursor, both of which are themselves derived
   * from the data, so re-running a page after a crash writes the same path (AGENTS.md §3.6). The
   * object is replaced rather than appended to: a retry is a rewrite of the same page, never an
   * append that would double rows.
   */
  async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
    await mkdir(this.root, { recursive: true });
    const objectPath = this.pathFor(page.partition, page.cursor);
    const temporaryPath = `${objectPath}.partial`;

    const body = `${page.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    // The manifest carries the digest of the rows as the domain computed them, not a digest of the
    // serialised bytes. A restore recomputes the former from what it read back and compares, so the
    // check survives a change of line terminator or key ordering in a future client.
    const manifest = {
      format: 'audit-archive-ndjson/1',
      partition: page.partition,
      cursor: page.cursor,
      periodFrom: page.periodFrom,
      periodThrough: page.periodThrough,
      rows: page.entries.length,
      digest: auditArchiveDigest(page.entries),
      retention: page.retention,
      contentSha256: createHash('sha256').update(body).digest('hex'),
      writtenAt: new Date().toISOString(),
    };

    await writeFile(temporaryPath, body, 'utf8');
    await writeFile(`${temporaryPath}.manifest`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, objectPath);
    await rename(`${temporaryPath}.manifest`, `${objectPath}.manifest`);

    return {
      partition: page.partition,
      cursor: page.cursor,
      objectUri: `file://${objectPath}`,
      rows: page.entries.length,
      digest: manifest.digest,
      archivedAt: manifest.writtenAt,
    };
  }

  async read(objectUri: string): Promise<readonly AuditArchiveEntry[]> {
    const objectPath = this.pathFromUri(objectUri);
    const body = await readFile(objectPath, 'utf8');
    const lines = body.split('\n').filter((line) => line.length > 0);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as AuditArchiveEntry;
      } catch (cause) {
        // Refusing a partial line is the point. A truncated file is exactly the corruption a restore
        // exists to catch, and silently returning the prefix would turn missing evidence into a
        // smaller archive that still verifies against a smaller expectation.
        throw new Error(
          `Archived object ${objectUri} has an unparseable line ${index + 1} of ${lines.length}: ${String(cause)}`,
        );
      }
    });
  }

  /** The manifest as stored, so a verifier can check what the writer claimed without trusting it. */
  async readManifest(objectUri: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(`${this.pathFromUri(objectUri)}.manifest`, 'utf8')) as Record<string, unknown>;
  }

  /**
   * Delete an artifact, gated on a finite retention obligation.
   *
   * The gate is here rather than only in the purge SQL because the filesystem is the one place where
   * a mistake is unrecoverable: dropping a row from the hot table is a transaction that can be rolled
   * back, `unlink` cannot. `audit.retention_years = KOSONG` means the artifact is never destroyed,
   * so this refuses an object whose retention is INDEFINITE even if a caller asks.
   */
  async purge(objectUri: string): Promise<boolean> {
    const manifest = await this.readManifest(objectUri);
    const retention = manifest.retention as { mode?: string } | undefined;
    if (retention?.mode !== 'PURGE_AFTER') {
      return false;
    }
    await rm(this.pathFromUri(objectUri), { force: true });
    await rm(`${this.pathFromUri(objectUri)}.manifest`, { force: true });
    return true;
  }

  private pathFor(partition: string, cursor: string): string {
    return join(this.root, `${sanitise(partition)}__${sanitise(cursor)}.ndjson`);
  }

  private pathFromUri(objectUri: string): string {
    if (!objectUri.startsWith('file://')) {
      throw new Error(`FileAuditArchive can only read its own file:// URIs, not ${objectUri}.`);
    }
    return objectUri.slice('file://'.length);
  }
}

/**
 * Partition and cursor names come from the catalogue, not from user input, but they are interpolated
 * into a filesystem path here. Reducing them to a safe alphabet means a surprising name cannot escape
 * the root, and it keeps the rejection local rather than depending on a caller to have validated.
 */
function sanitise(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
