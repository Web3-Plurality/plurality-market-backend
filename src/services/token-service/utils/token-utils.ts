import * as crypto from 'crypto';
import Logger from '../../../lib/logger';

export const TOKEN_PREFIX = 'plur_pat_';
const RANDOM_BYTES = 32;

const HMAC_PEPPER = process.env.PAT_HMAC_PEPPER || '';
if (!HMAC_PEPPER) {
  Logger.warn('[token-utils] PAT_HMAC_PEPPER env var is not set — set this to a strong random secret in production');
}

export interface GeneratedToken {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateToken(): GeneratedToken {
  const random = crypto.randomBytes(RANDOM_BYTES).toString('base64url');
  const plaintext = `${TOKEN_PREFIX}${random}`;
  const prefix = plaintext.slice(0, 16);
  const hash = hashToken(plaintext);
  return { plaintext, prefix, hash };
}

export function hashToken(plaintext: string): string {
  return crypto.createHmac('sha256', HMAC_PEPPER).update(plaintext).digest('hex');
}

export function verifyTokenHash(plaintext: string, expectedHash: string): boolean {
  const actual = hashToken(plaintext);
  if (actual.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function isPatToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}
