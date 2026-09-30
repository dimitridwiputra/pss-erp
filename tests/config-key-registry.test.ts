import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseRegistryCatalog, isConfigKey } from '../scripts/generate-registry-catalog.mjs';

/**
 * TAX-CONFIG-01 / TAX-CONFIG-02 and the generator rules behind them.
 *
 * Both original defects were silent: the VAT cell produced one key matching neither, and prose in
 * Appendix N.2 turned `pss_mode` and `warehouse_id` into writable configuration keys. A generator
 * that drops a bad key quietly looks identical to one that never saw it, so these tests assert on
 * presence AND on the generator refusing malformed input.
 */
const markdown = await readFile(new URL('../docs/PRODUCT_PRD.md', import.meta.url), 'utf8');
const catalog = parseRegistryCatalog(markdown);

const seedKeys = catalog.configurationSeeds.map((entry) => entry.keyExpression);
const additionKeys = catalog.configurationAdditions.flatMap((entry) => entry.keys ?? []);
const everyKey = [...new Set([...seedKeys, ...additionKeys])];

describe('TAX-CONFIG-01 — the two VAT rates are independent registered keys', () => {
  it('registers tax.vat_output_rate', () => {
    expect(seedKeys).toContain('tax.vat_output_rate');
  });

  it('registers tax.vat_input_rate', () => {
    expect(seedKeys).toContain('tax.vat_input_rate');
  });

  it('registers neither as the packed cell that matched both halves', () => {
    // The original defect in one assertion: this key matched no real configuration and would have
    // raised CONFIG_KEY_UNKNOWN for every caller that named a real VAT rate.
    expect(everyKey).not.toContain('tax.vat_output_rate` / `tax.vat_input_rate');
    expect(everyKey.some((key) => key.includes('`'))).toBe(false);
  });

  it('gives the two rates independent rows, so one can be configured without the other', () => {
    const output = catalog.configurationSeeds.find((e) => e.keyExpression === 'tax.vat_output_rate');
    const input = catalog.configurationSeeds.find((e) => e.keyExpression === 'tax.vat_input_rate');
    expect(output).toBeDefined();
    expect(input).toBeDefined();
    expect(output).not.toBe(input);
  });
});

describe('TAX-CONFIG-02 — policy fields are not writable configuration', () => {
  it('does not register pss_mode', () => {
    expect(everyKey).not.toContain('pss_mode');
  });

  it('does not register warehouse_id', () => {
    expect(everyKey).not.toContain('warehouse_id');
  });

  it('records them as documented policy fields instead of dropping them silently', () => {
    // PrincipalSystemPolicy still owns them, so the information has to survive somewhere. Silently
    // discarding it would be indistinguishable from never having read it.
    const policyRows = catalog.configurationAdditions.filter((entry) => entry.documentedOnly?.length);
    const documented = policyRows.flatMap((entry) => entry.documentedOnly ?? []);
    expect(documented).toContain('pss_mode');
    expect(documented).toContain('warehouse_id');
  });

  it('emits no writable key from any non-writable row', () => {
    const nonWritable = catalog.configurationAdditions.filter((entry) => entry.documentedOnly);
    for (const row of nonWritable) {
      expect(row.keys).toEqual([]);
    }
  });
});

describe('the config-key grammar is enforced, not inferred from backticks', () => {
  it('accepts namespaced lowercase keys', () => {
    expect(isConfigKey('tax.vat_output_rate')).toBe(true);
    expect(isConfigKey('ar.aging_buckets')).toBe(true);
  });

  it('rejects a bare identifier, which is what let the prose through', () => {
    expect(isConfigKey('pss_mode')).toBe(false);
    expect(isConfigKey('warehouse_id')).toBe(false);
  });

  it('rejects a template with a placeholder segment, which is not one writable key', () => {
    expect(isConfigKey('approval.<type>.levels')).toBe(false);
    expect(isConfigKey('media.policy.<purpose>')).toBe(false);
  });

  it('registers no key that fails the grammar', () => {
    const offenders = everyKey.filter((key) => !isConfigKey(key));
    expect(offenders).toEqual([]);
  });

  it('rejects an N.1 cell that packs two keys into one row', () => {
    // The structural fix: one canonical key per row. Re-packing the VAT cell must fail loudly
    // rather than quietly regenerating the original defect.
    const packed = markdown.replace(
      '| `tax.vat_output_rate` |',
      '| `tax.vat_output_rate` / `tax.vat_input_rate` |',
    );
    expect(() => parseRegistryCatalog(packed)).toThrow(/exactly one configuration key/);
  });

  it('rejects a writable row whose key fails the grammar', () => {
    const broken = markdown.replace('`tax.export_format_version`', '`tax_export_format_version`');
    expect(() => parseRegistryCatalog(broken)).toThrow(/not a valid configuration key/);
  });

  it('rejects an unrecognised kind rather than guessing whether it is writable', () => {
    const unknown = markdown.replace('| Flag | `integration.outbound_enabled`', '| Mystery | `integration.outbound_enabled`');
    expect(() => parseRegistryCatalog(unknown)).toThrow(/unrecognised kind/);
  });

  it('matches the kind column case-insensitively', () => {
    // Appendix N.2 wrote "Policy field" where an earlier version of this generator expected
    // "Policy Field", and the mismatch downgraded a non-writable row to an unknown kind.
    const lower = markdown.replace('| Policy Field | `approval.<type>.levels`', '| Policy field | `approval.<type>.levels`');
    const parsed = parseRegistryCatalog(lower);
    const row = parsed.configurationAdditions.find((entry) => entry.documentedOnly?.includes('approval.<type>.levels'));
    expect(row).toBeDefined();
    expect(row?.keys).toEqual([]);
  });
});
