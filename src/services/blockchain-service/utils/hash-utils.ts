import { createHash } from 'crypto';

/**
 * Compute SHA-256 hash of content, returned as 0x-prefixed hex string.
 * Compatible with Solidity bytes32 format.
 */
export function hashContent(content: string | Buffer): string {
  return '0x' + createHash('sha256').update(content).digest('hex');
}

/**
 * Convert a UUID string to bytes16 hex for Solidity.
 * E.g. "550e8400-e29b-41d4-a716-446655440000" => "0x550e8400e29b41d4a716446655440000"
 */
export function uuidToBytes16(uuid: string): string {
  return '0x' + uuid.replace(/-/g, '');
}

/**
 * Convert bytes16 hex back to UUID string.
 * E.g. "0x550e8400e29b41d4a716446655440000" => "550e8400-e29b-41d4-a716-446655440000"
 */
export function bytes16ToUuid(bytes16: string): string {
  const hex = bytes16.replace('0x', '');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}
