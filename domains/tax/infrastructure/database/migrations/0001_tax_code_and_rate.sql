-- TAX-001: tax codes and effective-dated tax rates.
--
-- Schema: `core`, because PRD §18.2 puts "kode & tarif pajak" in the `core` schema owned by the
-- tax module (and `scripts/check-database.mjs`'s `schemaOwners` agrees: core's owners are
-- organization, master-data, principal-policy, commercial, tax). A `tax` schema exists in neither
-- the PRD nor the fitness function, so creating one here would be inventing a boundary.

-- `core` is co-owned by organization, master-data, principal-policy, commercial and tax
-- (PRD §18.2, `scripts/check-database.mjs`'s `schemaOwners`), and each of those domains' first
-- migration creates it, so a tax database can be migrated on its own.
CREATE SCHEMA IF NOT EXISTS core;

-- DB.R06 requires an exclusion constraint, and a `daterange` overlap test needs the uuid equality
-- operator class that ships in btree_gist: without it, GiST can index `&&` for ranges but not `=`
-- for the tax_code_id part of the same constraint, and the rule could not be enforced in one index.
-- Creating the extension needs a superuser or a DBA-owned bootstrap step in a real environment.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- The statutory vocabulary, not tenant data: VAT_OUTPUT, VAT_INPUT, EXEMPT, NON_VAT. One row per
-- code for the whole platform, like `platform.config_key`, because a code's meaning does not
-- change between organizations and a per-organization copy would let one tenant redefine the
-- vocabulary the others are measured against.
--
-- zero_rated is what makes EXEMPT and NON_VAT compute without a rate row. TAX-002 requires an
-- exempt sale to produce a valid zero-tax invoice, and TAX-001.AC02 requires a missing rate to
-- block a taxable one; the difference is a property of the code, so it is stored as data here
-- rather than hard-coded as a name list in the resolver.
CREATE TABLE IF NOT EXISTS core.tax_code (
  id uuid PRIMARY KEY,
  code text NOT NULL CHECK (code IN ('VAT_OUTPUT', 'VAT_INPUT', 'EXEMPT', 'NON_VAT')),
  name text NOT NULL,
  zero_rated boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code)
);

COMMENT ON TABLE core.tax_code IS
  'Statutory tax code vocabulary (VAT_OUTPUT, VAT_INPUT, EXEMPT, NON_VAT). Global, not per organization.';
COMMENT ON COLUMN core.tax_code.zero_rated IS
  'True for codes that carry no rate: EXEMPT and NON_VAT resolve to rate 0 without a tax_rate row and never require one.';

-- TAX-001.BR01/BR02/DB.R06: an organization's rate per code, effective-dated, approval-gated.
--
-- organization_id is NOT NULL (DB.R11): the vocabulary is global, the rates a company transacts
-- under are its own, which is the same split `platform.config_key`/`platform.config_value` makes.
--
-- rate is a percentage, not a fraction: 11.000000 means 11%. VAT rates move in whole or half
-- percentage points, so a fractional-percentage reading would store 0.110000 and invite a reader
-- to mistake it for 0.11%.
--
-- approval_id is a bare uuid rather than a foreign key: it references
-- `platform.approval_request`, and DB.R02 forbids a cross-schema foreign key. The reference is
-- resolved by the application contract, and TAX-001.NC02 is enforced by `activate_tax_rate`'s
-- guard plus the approval decision this domain consumes.
CREATE TABLE IF NOT EXISTS core.tax_rate (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  tax_code_id uuid NOT NULL REFERENCES core.tax_code (id),
  rate numeric(9,6) NOT NULL CHECK (rate >= 0),
  valid_from date NOT NULL,
  valid_to date,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'ACTIVE', 'EXPIRED')),
  approval_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A rate is effective-dated on a half-open range, so the day a new rate starts is the day the
  -- previous one stops: TAX-001.AC01 (an invoice dated D uses the new rate, D-1 the old one).
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

COMMENT ON COLUMN core.tax_rate.rate IS
  'Percentage points: 11.000000 is 11%. Never a fraction of one.';
COMMENT ON COLUMN core.tax_rate.status IS
  'SCHEDULED before approval, ACTIVE once APPROVAL_DECIDED approves it, EXPIRED once superseded by a later rate.';
COMMENT ON COLUMN core.tax_rate.approval_id IS
  'platform.approval_request.id for a tax_rate_change approval. Not a foreign key (DB.R02).';

-- DB.R06: overlapping effective ranges for the same (organization, code) are forbidden.
ALTER TABLE core.tax_rate DROP CONSTRAINT IF EXISTS tax_rate_effective_range_excl;
ALTER TABLE core.tax_rate ADD CONSTRAINT tax_rate_effective_range_excl
  EXCLUDE USING gist (
    organization_id WITH =,
    tax_code_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[)') WITH &&
  );

CREATE INDEX IF NOT EXISTS tax_rate_lookup_idx
  ON core.tax_rate (organization_id, tax_code_id, valid_from DESC)
  WHERE status = 'ACTIVE';

-- TAX-001.BR02: a rate that has been used is never edited; a change is a new row.
--
-- The row cannot be made fully append-only, because DB.R06's exclusion constraint only holds if
-- the predecessor's open range is closed when a successor is scheduled, and only the owning domain
-- may do that. So the economic content is frozen — code, rate, and start date — while the
-- lifecycle columns that have to move (valid_to, status) stay writable. An UPDATE that changes
-- rate, tax_code_id or valid_from is the rewrite this rule forbids, and is rejected by the
-- database rather than by a caller remembering to check.
-- A zero-rated code has no rate to schedule, and a row claiming one would let EXEMPT or NON_VAT
-- become taxable the moment a rate landed. A CHECK constraint cannot read another row, so the
-- rule is a trigger: it also covers a code that is later switched to zero_rated, which a check
-- written at insert time would not.
CREATE OR REPLACE FUNCTION core.reject_tax_rate_for_zero_rated_code()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code_zero_rated boolean;
  code_label text;
BEGIN
  SELECT zero_rated, code INTO code_zero_rated, code_label FROM core.tax_code WHERE id = NEW.tax_code_id;
  IF code_zero_rated THEN
    RAISE EXCEPTION 'tax code % is zero-rated and takes no rate row', code_label;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.reject_tax_rate_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tax_code_id IS DISTINCT FROM OLD.tax_code_id
     OR NEW.rate IS DISTINCT FROM OLD.rate
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN
    RAISE EXCEPTION 'a tax rate is never rewritten; schedule a new row with a later valid_from';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'core.tax_rate'::regclass AND tgname = 'tax_rate_zero_rated_code_only'
  ) THEN
    CREATE TRIGGER tax_rate_zero_rated_code_only BEFORE INSERT OR UPDATE OF tax_code_id ON core.tax_rate
      FOR EACH ROW EXECUTE FUNCTION core.reject_tax_rate_for_zero_rated_code();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'core.tax_rate'::regclass AND tgname = 'tax_rate_no_rewrite'
  ) THEN
    CREATE TRIGGER tax_rate_no_rewrite BEFORE UPDATE ON core.tax_rate
      FOR EACH ROW EXECUTE FUNCTION core.reject_tax_rate_rewrite();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'core.tax_rate'::regclass AND tgname = 'tax_rate_no_delete'
  ) THEN
    CREATE TRIGGER tax_rate_no_delete BEFORE DELETE ON core.tax_rate
      FOR EACH ROW EXECUTE FUNCTION core.reject_tax_rate_rewrite();
  END IF;
END;
$$;

REVOKE DELETE ON core.tax_rate FROM PUBLIC;