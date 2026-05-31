import { getContractClient } from './contract-client';
import Logger from '../../../lib/logger';

/**
 * Wallet → bucketHashes lookup, backed by the chain with a small in-memory
 * LRU cache to keep the permission resolver off the RPC hot path.
 *
 * Why a cache: every protected GET (list contexts, search bucket, get bucket
 * detail) now resolves access against on-chain NFT ownership. Without
 * caching, that's an RPC roundtrip per request. With a 30-second TTL the
 * chain stays the source of truth while typical hot-path access amortizes
 * to one RPC per wallet per half-minute.
 *
 * Why not a global event listener / indexer (yet): simpler to ship, fewer
 * moving parts, and the staleness window is bounded by the TTL. v1.5 can
 * add an indexer that proactively invalidates on Transfer.
 *
 * Cache invariants:
 *   - Keys are lowercased 0x-prefixed addresses (we never trust caller casing).
 *   - Values are Sets of 0x-prefixed lowercased 64-hex hashes.
 *   - Lookup of a non-cached or expired entry triggers a single RPC call;
 *     concurrent lookups for the same address coalesce via inflight map.
 *   - invalidate(address) drops the entry; next lookup re-fetches.
 */

const TTL_MS = 30_000;
const MAX_ENTRIES = 1000;

interface CacheEntry {
  hashes: Set<string>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>(); // insertion order = LRU order
const inflight = new Map<string, Promise<Set<string>>>();

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function normalizeHash(hash: string): string {
  // The contract returns bytes32 as 0x-prefixed lowercase hex; this normalizer
  // just guards against any caller passing mixed case so set equality holds.
  return hash.toLowerCase();
}

function evictIfFull(): void {
  if (cache.size < MAX_ENTRIES) return;
  // Drop the oldest entry (first inserted)
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

async function fetchFromChain(address: string): Promise<Set<string>> {
  const client = getContractClient();
  if (!client.isConfigured()) {
    // Without on-chain config, no one holds any NFTs from our point of view.
    // Returning an empty set means immutable buckets are inaccessible — which
    // is the correct fail-closed behavior for a misconfigured environment.
    Logger.warn('[wallet-nfts] Blockchain not configured; returning empty hash set');
    return new Set();
  }
  const raw = await client.getBucketHashesByOwner(address);
  return new Set(raw.map(normalizeHash));
}

/**
 * Get the set of bucketHashes the given wallet currently holds an NFT for.
 * Cached for TTL_MS. Concurrent calls coalesce.
 */
export async function walletToBucketHashes(address: string): Promise<Set<string>> {
  const key = normalizeAddress(address);
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.hashes;
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const hashes = await fetchFromChain(key);
      evictIfFull();
      cache.set(key, { hashes, fetchedAt: Date.now() });
      return hashes;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Drop the cached entry for `address`. Call this from any handler that
 * causes the wallet's NFT holdings to change (mint confirm, buy/sell). The
 * next read for the address will hit the chain.
 */
export function invalidateWallet(address: string): void {
  cache.delete(normalizeAddress(address));
}
