import { describe, expect, it } from 'vitest';
import {
  checkStatusVocabulary,
  readStatusStateUnions,
} from '../scripts/check-ui.mjs';
import {
  derivedStatusTones,
  derivedStatusVocabulary,
  fillDerivedStatusLabel,
  findDerivedStatusEntry,
  findStatusEntry,
  frontlineRole,
  missingStatusVocabularyEntries,
  pendingStatusLabels,
  resolveStatus,
  statusTones,
  statusVocabulary,
  unknownStatusEntry,
} from '../packages/ui/src/status-vocabulary';

const technicalCode = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/;

/** Appendix M labels longer than three words, kept verbatim. */
const approvedLongLabels = new Set([
  'Invoice|PREPARED|',
  'Receivable|DUE|',
  'Receivable|DUE|FRONTLINE',
  'Receivable|DISPUTED|FRONTLINE',
  'CashCustody|DISCREPANCY|FRONTLINE',
  'ProofOfDelivery|MISSING|',
  'ProofOfDelivery|MISSING|FRONTLINE',
  'OrderRequest|QUEUED|FRONTLINE',
  'OrderRequest|NEEDS_ATTENTION|FRONTLINE',
  'Sync|PENDING_SYNC|FRONTLINE',
]);

describe('UX-002 status vocabulary registry', () => {
  it('UX-002.BR02 uses only semantic tones', () => {
    expect([...statusTones]).toEqual(['neutral', 'info', 'success', 'warning', 'danger']);
    for (const row of statusVocabulary) expect(statusTones).toContain(row.tone);
    for (const row of Object.values(derivedStatusVocabulary)) expect(derivedStatusTones).toContain(row.tone);
  });

  it('UX-002.BR03 never shows a technical code in a label', () => {
    for (const row of statusVocabulary) {
      expect(technicalCode.test(row.label), `${row.stcCode}.${row.state} label`).toBe(false);
      expect(technicalCode.test(row.description), `${row.stcCode}.${row.state} description`).toBe(false);
      expect(row.label.trim()).not.toBe('');
      expect(row.icon.trim()).not.toBe('');
      expect(row.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('UX-002.BR01 keeps labels short and role keys unique', () => {
    const keys = statusVocabulary.map((row) => `${row.stcCode}|${row.state}|${row.role ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of statusVocabulary) {
      // UX-002.BR01 says "three words where possible". The four registered labels over
      // three words are the verbatim Appendix M wording, kept rather than reworded.
      const budget = approvedLongLabels.has(`${row.stcCode}|${row.state}|${row.role ?? ''}`) ? 5 : 3;
      expect(row.label.split(/\s+/).length, `${row.stcCode}.${row.state} label "${row.label}"`).toBeLessThanOrEqual(budget);
      if (row.role) expect(row.role).toBe(frontlineRole);
    }
  });

  it('UX-002.AC01 fails a new contract state that has no label and no pending entry', async () => {
    const unions = await readStatusStateUnions();
    expect(missingStatusVocabularyEntries(unions)).toEqual([]);
    expect(missingStatusVocabularyEntries([{ stcCode: 'PosSale', states: ['PAID', 'BRAND_NEW_STATE'] }]))
      .toEqual([{ stcCode: 'PosSale', state: 'BRAND_NEW_STATE' }]);
  });

  it('keeps the pending list honest: no registered state may also be pending', async () => {
    const unions = await readStatusStateUnions();
    const known = new Set(unions.flatMap(({ stcCode, states }) => states.map((state) => `${stcCode}|${state}`)));
    for (const row of pendingStatusLabels) {
      expect(known.has(`${row.stcCode}|${row.state}`), `${row.stcCode}.${row.state}`).toBe(true);
      expect(row.reason.trim().length).toBeGreaterThan(0);
      expect(findStatusEntry({ stcCode: row.stcCode, state: row.state })).toBeUndefined();
    }
  });

  it('pnpm ui:check reports no issue for the current registry', async () => {
    expect(await checkStatusVocabulary()).toEqual([]);
  });
});

describe('UX-002 status resolution', () => {
  it('UX-002.AC02 returns a status object, not a bare state', () => {
    expect(resolveStatus({ stcCode: 'PosSale', state: 'PAID' }))
      .toEqual({ code: 'PAID', label: 'Lunas', tone: 'success', icon: 'check-circle', description: 'Transaksi sudah lunas.', known: true });
    expect(resolveStatus({ stcCode: 'PosShift', state: 'OPEN' })).toMatchObject({ label: 'Shift berjalan', tone: 'info' });
  });

  it('UX-002.AC04 prefers a role label and falls back to the desktop default', () => {
    expect(resolveStatus({ stcCode: 'SalesOrder', state: 'DRAFT', role: frontlineRole }).label).toBe('Belum dikirim');
    expect(resolveStatus({ stcCode: 'SalesOrder', state: 'DRAFT' }).label).toBe('Draf');
    expect(resolveStatus({ stcCode: 'SalesOrder', state: 'CANCELLED', role: frontlineRole }).label).toBe('Batal');
    // A role-specific copy that is not approved for this role falls back, never blanks out.
    expect(resolveStatus({ stcCode: 'PosSale', state: 'PAID', role: frontlineRole }).label).toBe('Lunas');
  });

  it('UX-002.E2 hides the raw code for an unknown state', () => {
    const unknown = resolveStatus({ stcCode: 'PosSale', state: 'QUANTUM_STATE' });
    expect(unknown).toEqual({ code: 'QUANTUM_STATE', ...unknownStatusEntry, known: false });
    expect(unknown.label).toBe('Status tidak dikenal');
    expect(unknown.label).not.toContain('QUANTUM_STATE');
    expect(unknown.description).toContain('Muat ulang halaman');
    expect(resolveStatus({ stcCode: 'NoSuchAggregate', state: 'DRAFT' }).known).toBe(false);
  });

  it('resolves the derived Appendix M rows and fills their placeholders', () => {
    const overdue = findDerivedStatusEntry('Receivable · OVERDUE_*');
    expect(overdue).toMatchObject({ tone: 'danger', icon: 'alarm-clock' });
    expect(fillDerivedStatusLabel(overdue!, { n: 12 })).toBe('Terlambat 12 hari');
    expect(fillDerivedStatusLabel(overdue!, {})).toBe('Terlambat {n} hari');

    const observed = findDerivedStatusEntry('SalesOrder · VALIDATED (observed)');
    expect(observed?.tone).toBe('external');
    expect(fillDerivedStatusLabel(observed!, { sumber: 'ND6' })).toBe('Tercatat dari ND6');

    expect(findDerivedStatusEntry('SalesOrder · VALIDATED + CreditDecision ON_HOLD', frontlineRole)?.labelTemplate)
      .toBe('Perlu persetujuan kredit');
    expect(findDerivedStatusEntry('SalesOrder · VALIDATED + CreditDecision ON_HOLD')?.labelTemplate)
      .toBe('Menunggu persetujuan kredit');
    expect(findDerivedStatusEntry('Not · A · Row')).toBeUndefined();
  });
});
