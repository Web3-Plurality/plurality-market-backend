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

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: 5432,
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
  synchronize: true,
  ssl: {
    // eslint-disable-next-line
    // @ts-ignore
    require: true,
    rejectUnauthorized: true, // Set to true in production with a valid certificate
    ca: fs.readFileSync('certificates/eu-north-1-bundle.pem').toString(),
  },
});
