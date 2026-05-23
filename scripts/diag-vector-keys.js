// Print the vector_ids stored for each context in a bucket.
// Usage: node scripts/diag-vector-keys.js <profileId>
require('dotenv').config();
const { Client } = require('pg');

const profileId = process.argv[2];
if (!profileId) {
  console.error('Usage: node scripts/diag-vector-keys.js <profileId>');
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

  const r = await c.query(
    `SELECT "contextId", title, "userId", "vectorIds" FROM user_context WHERE "profileId" = $1`,
    [profileId],
  );

  for (const row of r.rows) {
    console.log(`\nctx=${row.contextId} title="${row.title}" user=${row.userId}`);
    console.log('  vectorIds:', row.vectorIds);
  }

  await c.end();
})().catch((err) => {
  console.error('Diag failed:', err.message);
  process.exit(1);
});
