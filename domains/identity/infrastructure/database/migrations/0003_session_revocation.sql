ALTER TABLE identity.user_account
  ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;
