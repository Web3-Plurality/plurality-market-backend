# Phase 12 — wipe, redeploy, smoke test

Run these in order. Stop and ask if anything diverges.

## 1. Redeploy contracts (Phase 1 already shipped the Solidity)

```bash
cd c:/Users/tizh/oasis-mcp-m2/plurality-context-contracts
npx hardhat run scripts/deploy-market.ts --network oasisSapphireTestnet
```

Copy the two printed addresses into `plurality-market-backend/.env`:

```
MEMORY_NFT_CONTRACT_ADDRESS=0x...
CONTEXT_REGISTRY_ADDRESS=0x...
```

The deploy script also propagates fresh ABIs into:
- `plurality-market-backend/src/services/blockchain-service/abis/`
- `plurality-market-place/src/abis/`

(The market-backend ABI was already refreshed manually in Phase 4 — the script overwrite is a no-op match.)

## 2. Wipe Postgres

Pre-rewrite rows have columns that no longer match the entities (PATs without
`authAddress`, profiles without `bucketHash` / `isImmutable`, dead
`nft_snapshot` / `nft_mint` rows). `synchronize: true` will add new columns
but leaves rows behind that fail the new auth contract.

```bash
psql "postgres://USER:PASS@HOST:5432/plurality_marketplace_local" \
  -f c:/Users/tizh/oasis-mcp-m2/plurality-market-backend/scripts/phase12-wipe.sql
```

If `psql` isn't on PATH (Windows), use the Node + `pg` workaround from the
earlier diagnostic scripts (`scripts/diag-bucket.js`).

## 3. Restart services

```
plurality-market-backend   → npm run dev
plurality-market-mcp       → uvicorn / fastmcp launcher
plurality-market-place     → npm run dev
```

(plurality-market-ai-service does NOT need a restart — vector store untouched.)

## 4. Smoke test

Wallet A = creator. Wallet B = buyer.

| Step | Expected |
|---|---|
| Connect Wallet A in marketplace UI, sign SIWE | Cookie set; `/ai/profile` returns `[]` |
| Create a bucket, add 2 raw text contexts | bucket appears with `Draft` badge; `bucketHash` field populated in DB (`SELECT id, bucketHash FROM user_ai_profile`) |
| Click "Mint as NFT", fill dialog, sign tx in MetaMask | bucket badge flips to `Locked · NFT #1`; `mintedTokenId`, `mintedAt`, `mintTxHash` populated; `isImmutable = true` |
| Open the locked bucket | Read-only banner shows; Add/Upload/Delete controls hidden |
| Try `POST /ai/context/add-raw-context` with the same profileId via curl | 403 `bucket_immutable` |
| List the NFT for sale (any price) | `listingActive=true`; visible in `/marketplace/listings` |
| Disconnect Wallet A, connect Wallet B | Different cookie; `/ai/profile` returns `[]` (no creator-side rows for B) |
| Buy the listing from Wallet B | tx confirms; backend `/buy/:tokenId` returns 200 |
| After buy: Wallet B's `/blockchain/acquired-nfts` | includes the bucket |
| Wallet B searches via MCP (`mcp__plurality__search_memory`) on this bucket | returns contexts |
| Reconnect Wallet A: `/blockchain/my-nfts` | empty (token sold) |
| Wallet A tries to read the bucket | 404 (NFT-derived access fails) |
| Wallet A creates a NEW bucket, adds contexts | works normally (drafts owned by creator) |

## 5. Things to watch for

- **Cache stale window**: wallet→NFTs cache TTL is 30s. After buy, both
  wallets get explicit invalidation, but if you test back-to-back from a
  fresh terminal you might briefly hit the cache. Wait 30s or restart the
  backend to drop the in-process cache.
- **`getBucketHashesByOwner` RPC**: every protected read on an immutable
  bucket now hits this view function on cache miss. If Sapphire testnet is
  slow, expect 200–800ms latency on cold reads. Cache amortizes it.
- **Mint-cancel UX**: if MetaMask is closed without signing, the bucket
  stays frozen until the cancel button is wired (MintBucketButton already
  fires it on write-error). If the tab is closed before write-error fires,
  the bucket is stuck — call `POST /blockchain/mint/:profileId/cancel`
  directly.
