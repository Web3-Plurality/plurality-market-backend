-- Phase 12 wipe — destructive. Drops every market-backend table so TypeORM's
-- synchronize:true rebuilds them from the post-rewrite entities. Run AFTER the
-- contract redeploy (so any prepared mints against the old contract are gone)
-- and BEFORE restarting the market-backend.
--
-- Connect as the DB owner:
--   psql "postgres://USER:PASS@HOST:5432/plurality_marketplace_local"
-- then \i this file.
--
-- The DROP TABLE … CASCADE form is preferred over DROP DATABASE here so you
-- don't need to disconnect every backend pod before running, and so the
-- TypeORM user keeps its grants.

BEGIN;

-- Tables that no longer exist as entities (gone in this rewrite).
DROP TABLE IF EXISTS nft_snapshot CASCADE;
DROP TABLE IF EXISTS nft_mint     CASCADE;

-- Tables whose schema changed materially. Truncating is enough — TypeORM
-- ALTERs the columns; we just don't want pre-rewrite rows hanging around
-- (PATs without authAddress, profiles with the now-defunct
--  sourceSnapshotId/sourceNftTokenId columns, etc).
TRUNCATE TABLE
  user_ai_profile,
  user_context,
  personal_access_token,
  user_sessions,
  notification,
  activity_log
RESTART IDENTITY CASCADE;

-- Keep the users table — wallet→user mapping is durable across the rewrite.
-- If you want a fully fresh start, uncomment:
--   TRUNCATE TABLE users RESTART IDENTITY CASCADE;

COMMIT;

-- After this:
--   1. Restart market-backend so TypeORM synchronize applies new columns
--      (UserAiProfile.bucketHash / isImmutable / mintedTokenId / ...,
--       PersonalAccessToken.authAddress).
--   2. Restart market-mcp (it reads the PAT verify response — auth_address).
--   3. ai-service needs no restart; vector store is untouched.
