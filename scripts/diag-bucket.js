// One-shot diagnostic: inspect a bucket + its contexts.
// Usage: node scripts/diag-bucket.js <profileId>
require('dotenv').config();
const { Client } = require('pg');

const profileId = process.argv[2];
if (!profileId) {
  console.error('Usage: node scripts/diag-bucket.js <profileId>');
  process.exit(1);
}

(async () => {
  const c = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const bucket = await c.query(
    `SELECT id, "profileName", "userId", "sourceSnapshotId", "sourceNftTokenId", "createdAt"
     FROM user_ai_profile WHERE id = $1`,
    [profileId],
  );
  if (bucket.rows.length === 0) {
    console.log(`Bucket ${profileId} NOT FOUND in user_ai_profile`);
    await c.end();
    return;
  }
  console.log('BUCKET:');
  console.table(bucket.rows);

  const contexts = await c.query(
    `SELECT "contextId", title, status, "errorMessage", "contentSize",
            (CASE WHEN "vectorIds" IS NULL THEN 0
                  ELSE jsonb_array_length(COALESCE("vectorIds"::jsonb, '[]'::jsonb)) END) AS vector_count,
            "userId" AS context_user_id, "createdAt"
     FROM user_context WHERE "profileId" = $1 ORDER BY "createdAt" ASC`,
    [profileId],
  );
  console.log(`\nCONTEXTS (${contexts.rows.length}):`);
  console.table(contexts.rows);

  // Also check if there are OTHER users in the users table — confirms dual-row
  const ownerId = bucket.rows[0].userId;
  const dup = await c.query(
    `SELECT id, "authAddress" FROM users
      WHERE LOWER("authAddress") IN (
        SELECT LOWER("authAddress") FROM users WHERE id = $1
      )`,
    [ownerId],
  );
  if (dup.rows.length > 1) {
    console.log(`\n⚠ DUAL-ROW USERS DETECTED for the wallet that owns this bucket:`);
    console.table(dup.rows);
  } else {
    console.log(`\nNo duplicate users rows for this wallet — single canonical user.`);
  }

  await c.end();
})().catch((err) => {
  console.error('Diag failed:', err.message);
  process.exit(1);
});
