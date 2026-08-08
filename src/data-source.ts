import { DataSource } from 'typeorm';
import fs from 'fs';
import * as dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

// Fix for PostgreSQL timestamp parsing - treat timestamps as UTC
// OID 1114 = timestamp without time zone
// OID 1184 = timestamp with time zone
pg.types.setTypeParser(1114, (stringValue: string) => new Date(stringValue + 'Z'));
pg.types.setTypeParser(1184, (stringValue: string) => new Date(stringValue));

// Optional TLS CA for managed Postgres (e.g. AWS RDS). Point DB_SSL_CA_PATH
// at a CA bundle to enable verified TLS; without one (local Postgres, CI)
// the connection is made without TLS.
const dbCaPath = process.env.DB_SSL_CA_PATH || 'certificates/eu-north-1-bundle.pem';
const dbSsl = fs.existsSync(dbCaPath)
  ? { require: true, rejectUnauthorized: true, ca: fs.readFileSync(dbCaPath).toString() }
  : undefined;

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [
    'src/services/user-service/entity/*.ts',
    'src/services/auth-service/entity/*.ts',
    'src/services/ai-service/entity/*.ts',
    'src/services/token-service/entity/*.ts',
    // blockchain-service: nft_listing (per-(token,seller) marketplace listings
    // for multi-copy editions). NftMint/NftSnapshot were collapsed into
    // user_ai_profile (mintedTokenId, mintTxHash, …).
    'src/services/blockchain-service/entity/*.ts',
  ],
  // NOTE: schema sync is convenient for dev but a footgun against a real DB
  // (it can drop removed columns). Move to migrations before accepting
  // outside contributions.
  synchronize: true,
  ssl: dbSsl,
});
