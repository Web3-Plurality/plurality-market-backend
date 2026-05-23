-- ============================================================================
-- One-shot cleanup for duplicate `users` rows that point at the same wallet.
--
-- Background:
--   The SIWE controller does a case-insensitive lookup before insert, but
--   nothing in the schema prevents two concurrent SIWE logins for the same
--   wallet from both seeing "no row" and both inserting. Plus, this database
--   inherited legacy duplicates from earlier (pre-market-stack) testing.
--
-- This script:
--   1. Picks the OLDEST row per lowercased authAddress as canonical.
--   2. Reassigns every dependent row (user_ai_profile, user_context,
--      personal_access_token, profile_access, nft_mint, nft_snapshot) from
--      the duplicates to the canonical id.
--   3. Deletes the duplicate users rows.
--   4. Adds a functional UNIQUE index on LOWER(authAddress) so the race
--      can never recur. (The SIWE controller catches the resulting unique
--      violation and re-fetches the row the other request inserted.)
--
-- Run once against the market database:
--   psql "$DB_URL" -f scripts/dedupe-users.sql
--
-- Idempotent: safe to re-run; subsequent runs are no-ops.
-- ============================================================================

BEGIN;

-- 1. Build the canonical map: lowest createdAt wins per lowercased address.
-- (NULL authAddress rows are excluded — they're not the duplicate scenario.)
CREATE TEMP TABLE canonical_users AS
SELECT
  LOWER("authAddress")             AS lowered,
  (SELECT u2.id
     FROM users u2
     WHERE LOWER(u2."authAddress") = LOWER(u1."authAddress")
     ORDER BY u2.id::text          -- deterministic tiebreak (no createdAt column on `users`)
     LIMIT 1)                      AS canonical_id
FROM users u1
WHERE u1."authAddress" IS NOT NULL
GROUP BY LOWER(u1."authAddress");

-- 2. Build the duplicate-to-canonical mapping.
CREATE TEMP TABLE user_remap AS
SELECT u.id AS old_id, c.canonical_id AS new_id
FROM users u
JOIN canonical_users c ON LOWER(u."authAddress") = c.lowered
WHERE u.id <> c.canonical_id;

-- Show what we're about to do (visible in psql output).
SELECT
  (SELECT COUNT(*) FROM canonical_users)             AS distinct_wallets,
  (SELECT COUNT(*) FROM user_remap)                  AS duplicate_rows_to_merge;

-- 3. Reassign every dependent table to the canonical user id.
-- The DO block lets us skip tables that don't exist in this DB (the schema
-- evolves; some entities may not be created yet).
DO $$
DECLARE
  t RECORD;
  user_col TEXT;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('user_ai_profile',         'userId'),
      ('user_context',            'userId'),
      ('user_context',            'addedBy'),
      ('personal_access_token',   'userId'),
      ('profile_access',          'ownerId'),
      ('profile_access',          'grantedToId'),
      ('nft_mint',                'userId')
    ) AS t(table_name, user_col)
  LOOP
    -- Skip if table doesn't exist
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = t.table_name
    ) THEN
      RAISE NOTICE 'Skipping %: table not present', t.table_name;
      CONTINUE;
    END IF;
    -- Skip if column doesn't exist (e.g. addedBy on older user_context)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t.table_name AND column_name = t.user_col
    ) THEN
      RAISE NOTICE 'Skipping %.%: column not present', t.table_name, t.user_col;
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I SET %I = r.new_id FROM user_remap r WHERE %I = r.old_id',
      t.table_name, t.user_col, t.user_col
    );
    GET DIAGNOSTICS user_col = ROW_COUNT;
    RAISE NOTICE 'Reassigned % rows in %.%', user_col, t.table_name, t.user_col;
  END LOOP;
END $$;

-- 4. nft_snapshot keeps ownerWallet (a string, not a userId FK) — no remap needed.
--    But there IS a userId-ish column if any future entity adds one. Add here.

-- 5. Delete the duplicate users rows now that nothing points at them.
DELETE FROM users WHERE id IN (SELECT old_id FROM user_remap);

-- 6. Normalize stored authAddress values to lowercase so future joins
--    don't have to call LOWER() everywhere.
UPDATE users
SET "authAddress" = LOWER("authAddress")
WHERE "authAddress" IS NOT NULL
  AND "authAddress" <> LOWER("authAddress");

-- 7. Add the functional unique index. PostgreSQL allows expression-based
--    UNIQUE indexes; partial WHERE skips NULL addresses (email-only stubs).
--    "IF NOT EXISTS" makes this re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS users_lower_auth_address_unique
  ON users (LOWER("authAddress"))
  WHERE "authAddress" IS NOT NULL;

COMMIT;

-- Diagnostic: should be 0 if everything worked.
SELECT
  LOWER("authAddress") AS lowered,
  COUNT(*)             AS row_count
FROM users
WHERE "authAddress" IS NOT NULL
GROUP BY LOWER("authAddress")
HAVING COUNT(*) > 1;
