import express, { Request, Response } from 'express';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { AppDataSource } from '../../../data-source';
import { UserAiProfile } from '../../ai-service/entity/user-ai-profile';
import { UserContext } from '../../ai-service/entity/user-context';
import { resolveProfileAccess } from '../../ai-service/utils/permission';
import { recomputeAndStore as recomputeBucketHash } from '../../ai-service/utils/bucket-hash';
import { invalidateWallet as invalidateWalletNftCache, walletToBucketHashes } from '../utils/wallet-nfts';
import { logActivity } from '../../ai-service/utils/activity';
import { getContractClient } from '../utils/contract-client';
import { hashContent } from '../utils/hash-utils';
import Logger from '../../../lib/logger';

// Cloudinary is already configured by profile-controller.ts via cloudinary.config()
// at module load — but blockchain-controller may load first depending on import
// order, so we re-call config defensively. The library treats this as idempotent.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function clampString(val: unknown, max: number): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function sanitizeMintMetadata(body: any): {
  title: string | null;
  tagline: string | null;
  description: string | null;
  coverImage: string | null;
} {
  return {
    title: clampString(body?.title, 120),
    tagline: clampString(body?.tagline, 280),
    description: clampString(body?.description, 5000),
    coverImage: clampString(body?.coverImage, 500),
  };
}

export const blockchainRouter = express.Router();
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const userContextRepository = AppDataSource.getRepository(UserContext);

// Build a self-hosted metadata URI (no IPFS/Pinata needed)
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.plurality.network';

// On-chain tokenURI points at the bucket itself. The bucket is immutable
// from /mint onward, so this URL serves stable JSON.
function buildBucketMetadataURI(profileId: string): string {
  return `${API_BASE_URL}/blockchain/metadata/bucket/${profileId}`;
}

/**
 * Verify that a transaction emitted the expected on-chain event for a given
 * tokenId, with the expected actor wallet (and optional price). Used by
 * mint-confirm / list / delist / buy to refuse client-supplied txHashes that
 * don't actually correspond to the asserted action — without this, an
 * authenticated user could mark a listing/sale in our DB against a tx that
 * never happened (or that someone else performed), getting the marketplace
 * UI to display fake state.
 *
 * Returns null if verified, else an error string suitable for the client.
 */
async function verifyTxEvent(opts: {
  txHash: unknown;
  tokenId: number;
  expectEvent: 'Sold' | 'Listed' | 'Delisted' | 'Minted';
  expectActor: string; // wallet address that must appear on the event
  actorRole: 'from' | 'to'; // which side of the event the wallet should be on
  expectPrice?: string; // wei, optional (Listed/Sold)
}): Promise<string | null> {
  const { txHash, tokenId, expectEvent, expectActor, actorRole, expectPrice } = opts;
  if (!txHash || typeof txHash !== 'string') return 'txHash is required';

  const client = getContractClient();
  if (!client.isConfigured()) return 'Blockchain verification not available';

  const events = await client.getEventsFromTx(txHash, tokenId);
  const target = events.find((e) => e.event === expectEvent);
  if (!target) {
    return `Transaction does not contain a ${expectEvent} event for token #${tokenId}`;
  }

  const actor = (actorRole === 'from' ? target.from : target.to) || '';
  if (actor.toLowerCase() !== expectActor.toLowerCase()) {
    return `Transaction ${expectEvent} actor does not match caller wallet`;
  }

  if (expectPrice !== undefined && target.price !== expectPrice) {
    return `Transaction price (${target.price}) does not match recorded price (${expectPrice})`;
  }

  return null;
}

function buildContextMetadataURI(contextId: string): string {
  return `${API_BASE_URL}/blockchain/metadata/context/${contextId}`;
}

/**
 * GET /blockchain/contract-info
 * Get contract addresses, chain ID, and mint fee for frontend.
 */
blockchainRouter.get('/contract-info', async (req: Request, res: Response) => {
  try {
    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }
    const info = await client.getContractInfo();
    return res.status(200).json(info);
  } catch (error: any) {
    Logger.error('Failed to get contract info:', error);
    return res.status(500).json({ error: 'Failed to get contract info' });
  }
});

/**
 * GET /blockchain/mint-fee
 * Get current mint fee.
 */
blockchainRouter.get('/mint-fee', async (req: Request, res: Response) => {
  try {
    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }
    const fee = await client.getMintFee();
    return res.status(200).json({ mintFee: fee });
  } catch (error: any) {
    Logger.error('Failed to get mint fee:', error);
    return res.status(500).json({ error: 'Failed to get mint fee' });
  }
});

/**
 * GET /blockchain/metadata/bucket/:profileId
 * Public NFT metadata endpoint. On-chain tokenURI points here. Returns
 * OpenSea-style JSON describing the (immutable) bucket — name, description,
 * cover image, context count, bucketHash. Never includes raw content.
 */
blockchainRouter.get('/metadata/bucket/:profileId', async (req: Request, res: Response) => {
  try {
    const { profileId } = req.params;
    const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
    if (!profile) return res.status(404).json({ error: 'Bucket not found' });

    // Serve metadata for *minted* buckets. Buckets that are merely prepared
    // (isImmutable=true, mintedTokenId=null) are still served so that the
    // metadataURI resolves immediately when MetaMask fetches it during the
    // confirmation tx. Pure drafts (isImmutable=false) get 404.
    if (!profile.isImmutable) {
      return res.status(404).json({ error: 'Bucket is not minted' });
    }

    const contextCount = await userContextRepository.count({ where: { profileId } });

    const name = profile.nftTitle || profile.profileName;
    const description =
      profile.nftDescription || profile.nftTagline || `Plurality Memory Bucket: ${profile.profileName}`;
    const image = profile.nftCoverImage || profile.image || undefined;

    // Trimmed: nothing here is duplicated with the caller's already-known
    // state (URL contains profileId, on-chain call resolved tokenId, etc).
    // bucketHash stays in `properties` as the verification anchor for
    // HTTP-only consumers that don't want to make an RPC call for
    // `tokenToBucketHash(tokenId)`.
    return res.status(200).json({
      name,
      description,
      image,
      attributes: [{ trait_type: 'Contexts', value: contextCount }],
      properties: {
        bucketHash: profile.bucketHash,
        mintedAt: profile.mintedAt?.toISOString(),
      },
    });
  } catch (error: any) {
    Logger.error('Failed to serve bucket metadata:', error);
    return res.status(500).json({ error: 'Failed to serve metadata' });
  }
});

/**
 * POST /blockchain/upload-cover
 * Upload an NFT cover image to Cloudinary. Body: { image: base64-data-url }.
 * Returns: { url: string, publicId: string }.
 */
blockchainRouter.post('/upload-cover', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { image } = req.body as { image?: unknown };
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Image is required (data URL or remote URL)' });
    }
    if (image.length > 10_000_000) {
      return res.status(400).json({ error: 'Image is too large (max ~10MB)' });
    }

    const result = await cloudinary.uploader.upload(image, {
      folder: 'plurality/nft-covers',
      transformation: [{ width: 1200, height: 1200, crop: 'limit' }],
    });

    return res.status(200).json({
      url: result.secure_url,
      publicId: result.public_id,
    });
  } catch (error: any) {
    Logger.error('Failed to upload cover image:', error);
    return res.status(500).json({ error: 'Failed to upload image' });
  }
});

/**
 * GET /blockchain/metadata/context/:contextId
 * Self-hosted context metadata endpoint (replaces IPFS/Pinata).
 */
blockchainRouter.get('/metadata/context/:contextId', async (req: Request, res: Response) => {
  try {
    const { contextId } = req.params;

    const context = await userContextRepository.findOne({ where: { contextId } });
    if (!context) {
      return res.status(404).json({ error: 'Context not found' });
    }

    const metadata = {
      contextId,
      title: context.title || 'Untitled',
      description: context.description || '',
      sourceType: context.sourceType || 'text',
      sourcePlatform: context.sourcePlatform || null,
      contentHash: context.contentHash,
      contentSize: context.contentSize ? Number(context.contentSize) : null,
      originalFileName: context.originalFileName || null,
      addedAt: context.createdAt?.toISOString() || new Date().toISOString(),
      bucketProfileId: context.profileId,
      registeredOnChain: context.registeredOnChain,
      registryTxHash: context.registryTxHash,
    };

    return res.status(200).json(metadata);
  } catch (error: any) {
    Logger.error('Failed to serve context metadata:', error);
    return res.status(500).json({ error: 'Failed to serve metadata' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Mint flow (register-first, two-tx)
//
//   draft  ─────/prepare-registration─────►  frozen
//              (freeze + recompute hash)        │
//                                               ▼
//                                            user signs tx1 (registerContextBatch)
//                                               │
//                                       /confirm-registration
//                                            (verifies on-chain)
//                                               │
//                                               ▼
//                                          registered
//                                               │
//                              /prepare-mint  ──┤
//                                               ▼
//                                            user signs tx2 (mintBucket)
//                                               │
//                                       /confirm-mint
//                                               │
//                                               ▼
//                                            minted
//
//  Cancel is only valid in `frozen` (no on-chain writes yet). After `registered`
//  the chain is committed; the user must finish minting.
// ══════════════════════════════════════════════════════════════════════════

// Helper: load profile + assert caller is the original creator. The cancel /
// confirm endpoints need this rather than resolveProfileAccess because the
// bucket may be isImmutable=true but the NFT doesn't exist yet — the
// resolver's NFT-derived branch would always 403 the creator.
type LoadResult =
  | { ok: false; status: number; body: { error: string } }
  | { ok: true; profile: UserAiProfile; userId: string };

async function loadOwnedProfile(req: Request, profileId: string): Promise<LoadResult> {
  const userId = req?.user?.id;
  if (!userId) return { ok: false, status: 401, body: { error: 'unauthenticated' } };
  const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
  if (!profile) return { ok: false, status: 404, body: { error: 'Profile not found' } };
  if (profile.userId !== userId) {
    return { ok: false, status: 403, body: { error: 'Only the original creator can manage this mint' } };
  }
  return { ok: true, profile, userId };
}

/**
 * POST /blockchain/mint/:profileId/prepare-registration
 * Step 1 of 2. Freezes the bucket, recomputes bucketHash, stamps NFT metadata
 * onto the profile, and returns callData for `ContextRegistry.registerContextBatch`.
 * User signs the tx with their wallet (gas paid by user).
 *
 * Idempotent — safe to call again before the user signs (returns fresh callData
 * with the same bucketHash). Once registration is confirmed on-chain, calling
 * this again returns 409 (must proceed to prepare-mint).
 */
blockchainRouter.post('/mint/:profileId/prepare-registration', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { profileId } = req.params;
    const loaded = await loadOwnedProfile(req, profileId);
    if (!loaded.ok) return res.status(loaded.status).json(loaded.body);
    const { profile } = loaded;

    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }

    if (profile.mintedTokenId) {
      return res.status(409).json({ error: 'already_minted', tokenId: profile.mintedTokenId });
    }

    // Has on-chain registration already landed? If yes, this endpoint is the
    // wrong one — user should call /prepare-mint.
    if (profile.bucketHash) {
      const registrant = await client.getBucketRegistrant(profile.bucketHash);
      if (registrant !== '0x0000000000000000000000000000000000000000') {
        return res.status(409).json({
          error: 'already_registered',
          message: 'Contexts already on-chain. Proceed to /prepare-mint.',
          bucketHash: profile.bucketHash,
        });
      }
    }

    // Recompute bucketHash from current contexts so we register the exact
    // current state. Recompute is cheap and guarantees correctness even if
    // the per-write tracker drifted.
    const bucketHash = await recomputeBucketHash(profileId);
    if (!bucketHash) {
      return res.status(400).json({
        error: 'empty_bucket',
        message: 'Cannot mint an empty bucket — add at least one context first.',
      });
    }

    // Stamp NFT presentation metadata. Done at prepare-registration (not
    // prepare-mint) so all the NFT details are locked in alongside the
    // content freeze.
    const meta = sanitizeMintMetadata(req.body);
    profile.nftTitle = meta.title || profile.profileName;
    profile.nftTagline = meta.tagline;
    profile.nftDescription = meta.description;
    profile.nftCoverImage = meta.coverImage || profile.image || null;

    // Freeze the bucket. Phase 8's assertEditable now blocks every context
    // write — the contents the user is about to register on-chain are
    // exactly what stays on-chain.
    profile.isImmutable = true;
    await userAiProfileRepository.save(profile);

    // Gather context payload for the batch call. Order matches the bucketHash
    // ordering (createdAt ASC, contextId ASC) so the registry sees them in
    // the same sequence the hash was computed from.
    const contexts = await userContextRepository.find({
      where: { profileId },
      order: { createdAt: 'ASC', contextId: 'ASC' },
    });

    const contextIds: string[] = [];
    const contentHashes: string[] = [];
    const metadataURIs: string[] = [];
    const sourceTypes: string[] = [];
    for (const ctx of contexts) {
      const hash = await resolveContextHash(ctx);
      if (!hash) {
        Logger.warn(`[prepare-registration] skipping ${ctx.contextId} — no content hash`);
        continue;
      }
      contextIds.push(ctx.contextId);
      contentHashes.push(hash);
      metadataURIs.push(buildContextMetadataURI(ctx.contextId));
      sourceTypes.push(ctx.sourceType || 'text');
    }
    if (contextIds.length === 0) {
      return res.status(400).json({ error: 'no_hashable_contexts' });
    }

    const { to, data } = client.prepareRegisterContextBatch(
      bucketHash,
      contextIds,
      contentHashes,
      metadataURIs,
      sourceTypes,
    );

    return res.status(200).json({
      profileId,
      bucketHash,
      contextIds,
      contractAddress: to,
      callData: data,
    });
  } catch (error: any) {
    Logger.error('Failed to prepare registration:', error);
    return res.status(500).json({ error: 'Failed to prepare registration: ' + error.message });
  }
});

/**
 * POST /blockchain/mint/:profileId/confirm-registration
 * Step 1 confirm. Backend re-queries the on-chain registry to confirm the
 * batch landed (registrant claim + each context entry present), then marks
 * every context's `registeredOnChain = true` and stores the registry txHash.
 *
 * Body: { txHash, contextIds }  (contextIds echoed from prepare-registration)
 */
blockchainRouter.post('/mint/:profileId/confirm-registration', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const authAddress = req?.user?.authAddress;
    const { profileId } = req.params;
    const { txHash, contextIds } = req.body as { txHash?: string; contextIds?: string[] };
    if (!txHash || !Array.isArray(contextIds) || contextIds.length === 0) {
      return res.status(400).json({ error: 'txHash + contextIds[] required' });
    }

    const loaded = await loadOwnedProfile(req, profileId);
    if (!loaded.ok) return res.status(loaded.status).json(loaded.body);
    const { profile } = loaded;

    if (!profile.bucketHash) {
      return res.status(409).json({ error: 'not_prepared', message: 'Call /prepare-registration first' });
    }

    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }

    // The registry's bucketRegistrant for our bucketHash must equal the
    // caller's wallet — that's the on-chain proof the batch landed AND was
    // signed by the right wallet (which then lets `mintBucket` succeed).
    const registrant = await client.getBucketRegistrant(profile.bucketHash);
    if (registrant === '0x0000000000000000000000000000000000000000') {
      return res.status(409).json({
        error: 'not_visible_yet',
        message: 'Tx not visible on-chain yet — try again in a moment.',
      });
    }
    if (!authAddress || registrant !== authAddress.toLowerCase()) {
      Logger.warn(`[confirm-registration] registrant ${registrant} != caller ${authAddress}`);
      return res.status(403).json({ error: 'bucket_claimed_by_another_wallet', registrant });
    }

    // Per-context verify — confirms each contextId we expected actually
    // landed in the registry. Marks DB row registeredOnChain=true.
    const rows = await userContextRepository.find({
      where: contextIds.map((id) => ({ contextId: id, profileId })),
    });

    const confirmed: string[] = [];
    const pending: string[] = [];
    for (const ctx of rows) {
      if (!ctx.contentHash) {
        pending.push(ctx.contextId);
        continue;
      }
      const ok = await client.verifyContent(ctx.contextId, ctx.contentHash);
      if (ok) {
        ctx.registeredOnChain = true;
        ctx.registryTxHash = txHash;
        await userContextRepository.save(ctx);
        confirmed.push(ctx.contextId);
      } else {
        pending.push(ctx.contextId);
      }
    }

    return res.status(200).json({
      confirmed,
      pending,
      txHash,
      bucketHash: profile.bucketHash,
    });
  } catch (error: any) {
    Logger.error('Failed to confirm registration:', error);
    return res.status(500).json({ error: 'Failed to confirm registration: ' + error.message });
  }
});

/**
 * POST /blockchain/mint/:profileId/prepare-mint
 * Step 2 of 2. After registration is confirmed on-chain, returns callData for
 * `PluralityMemoryNFT.mintBucket(bucketHash, metadataURI)`. The NFT contract
 * itself verifies that `msg.sender == registry.bucketRegistrant[bucketHash]`,
 * so we don't need to re-check on the server; we just need contexts to be
 * registered.
 */
blockchainRouter.post('/mint/:profileId/prepare-mint', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const authAddress = req?.user?.authAddress;
    const { profileId } = req.params;

    const loaded = await loadOwnedProfile(req, profileId);
    if (!loaded.ok) return res.status(loaded.status).json(loaded.body);
    const { profile } = loaded;

    if (profile.mintedTokenId) {
      return res.status(409).json({ error: 'already_minted', tokenId: profile.mintedTokenId });
    }
    if (!profile.bucketHash) {
      return res.status(409).json({ error: 'not_registered', message: 'Call /prepare-registration first' });
    }

    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }

    // Sanity-check: registry has the caller as the bucket registrant.
    // The NFT will revert on chain otherwise — better to surface it here.
    const registrant = await client.getBucketRegistrant(profile.bucketHash);
    if (
      !authAddress ||
      registrant === '0x0000000000000000000000000000000000000000' ||
      registrant !== authAddress.toLowerCase()
    ) {
      return res.status(409).json({
        error: 'not_registered',
        message: 'Contexts must be registered by your wallet before minting.',
        registrant,
      });
    }

    const metadataURI = buildBucketMetadataURI(profileId);
    const callData = client.prepareMintData(profile.bucketHash, metadataURI);
    const mintFee = await client.getMintFee();

    return res.status(200).json({
      profileId,
      bucketHash: profile.bucketHash,
      metadataURI,
      contractAddress: callData.to,
      callData: callData.data,
      mintFee,
    });
  } catch (error: any) {
    Logger.error('Failed to prepare mint:', error);
    return res.status(500).json({ error: 'Failed to prepare mint: ' + error.message });
  }
});

/**
 * POST /blockchain/mint/:profileId/confirm-mint
 * Step 2 confirm. Verifies the BucketMinted event matches the caller's wallet
 * and the bucketHash we prepared, then stamps mintedTokenId on the profile
 * and invalidates the wallet→NFTs cache.
 */
blockchainRouter.post('/mint/:profileId/confirm-mint', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const authAddress = req?.user?.authAddress;
    const { profileId } = req.params;
    const { txHash } = req.body as { txHash?: string };
    if (!txHash) return res.status(400).json({ error: 'txHash is required' });

    const loaded = await loadOwnedProfile(req, profileId);
    if (!loaded.ok) return res.status(loaded.status).json(loaded.body);
    const { profile, userId } = loaded;

    if (!profile.bucketHash) {
      return res.status(409).json({ error: 'not_registered' });
    }
    if (profile.mintedTokenId) {
      return res.status(409).json({ error: 'already_confirmed', tokenId: profile.mintedTokenId });
    }

    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }

    const tokenId = await client.getTokenIdFromTx(txHash);
    if (tokenId === null) {
      return res.status(202).json({ status: 'confirming', txHash });
    }

    // Triple check the event matches what we expect: right tokenId, right
    // creator wallet, right bucketHash.
    const events = await client.getEventsFromTx(txHash, tokenId);
    const minted = events.find((e) => e.event === 'Minted');
    if (!minted) {
      return res.status(403).json({ error: `Transaction does not contain a Minted event for token #${tokenId}` });
    }
    if (!minted.to || !authAddress || minted.to.toLowerCase() !== authAddress.toLowerCase()) {
      Logger.warn(`[confirm-mint] caller ${authAddress} but Minted credits ${minted.to}`);
      return res.status(403).json({ error: 'Mint event credits a different wallet' });
    }
    if (!minted.bucketHash || minted.bucketHash !== profile.bucketHash.toLowerCase()) {
      Logger.warn(`[confirm-mint] bucketHash mismatch: tx ${minted.bucketHash} vs prepared ${profile.bucketHash}`);
      return res.status(403).json({ error: 'On-chain bucketHash does not match the prepared mint' });
    }

    profile.mintedTokenId = tokenId;
    profile.mintedAt = new Date();
    profile.mintTxHash = txHash;
    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await userAiProfileRepository.save(profile);

    if (authAddress) invalidateWalletNftCache(authAddress);

    logActivity(profileId, userId as string, 'bucket_minted', {
      targetType: 'profile',
      targetId: profileId,
      metadata: { tokenId, txHash, bucketHash: profile.bucketHash, chain: 'oasis-sapphire-testnet' },
    });

    return res.status(200).json({ status: 'minted', tokenId, txHash, bucketHash: profile.bucketHash });
  } catch (error: any) {
    Logger.error('Failed to confirm mint:', error);
    return res.status(500).json({ error: 'Failed to confirm mint' });
  }
});

/**
 * POST /blockchain/mint/:profileId/cancel
 * Reverts a frozen-but-not-yet-registered mint. Once registration has landed
 * on-chain, the chain is committed — no cancel; the user must finish minting
 * (call /prepare-mint + /confirm-mint).
 */
blockchainRouter.post('/mint/:profileId/cancel', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { profileId } = req.params;
    const loaded = await loadOwnedProfile(req, profileId);
    if (!loaded.ok) return res.status(loaded.status).json(loaded.body);
    const { profile } = loaded;

    if (!profile.isImmutable) {
      return res.status(409).json({ error: 'not_prepared', message: 'Nothing to cancel' });
    }
    if (profile.mintedTokenId) {
      return res.status(409).json({ error: 'already_minted', message: 'Mint already confirmed' });
    }

    // If registration already landed on-chain, the user is locked into the
    // bucketHash and must complete the mint — they can't go back to draft.
    if (profile.bucketHash) {
      const client = getContractClient();
      if (client.isConfigured()) {
        const registrant = await client.getBucketRegistrant(profile.bucketHash);
        if (registrant !== '0x0000000000000000000000000000000000000000') {
          return res.status(409).json({
            error: 'already_registered',
            message: 'Contexts already on-chain — finish minting via /prepare-mint instead of cancelling.',
          });
        }
      }
    }

    profile.isImmutable = false;
    profile.bucketHash = null;
    await userAiProfileRepository.save(profile);
    return res.status(200).json({ status: 'cancelled', profileId });
  } catch (error: any) {
    Logger.error('Failed to cancel mint:', error);
    return res.status(500).json({ error: 'Failed to cancel mint' });
  }
});

/**
 * GET /blockchain/mint/:profileId/status
 *   - not_minted: draft, no on-chain state
 *   - frozen:     prepared for registration (isImmutable=true), tx1 not landed
 *   - registered: tx1 confirmed (contexts on-chain), awaiting tx2
 *   - minted:     tx2 confirmed (NFT exists)
 */
blockchainRouter.get('/mint/:profileId/status', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { profileId } = req.params;
    const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (profile.mintedTokenId) {
      return res.status(200).json({
        status: 'minted',
        tokenId: profile.mintedTokenId,
        txHash: profile.mintTxHash,
        bucketHash: profile.bucketHash,
        mintedAt: profile.mintedAt?.toISOString(),
      });
    }
    if (!profile.isImmutable) {
      return res.status(200).json({ status: 'not_minted' });
    }
    // Frozen → check whether tx1 (registration) already landed.
    const allRegistered =
      profile.bucketHash &&
      (await userContextRepository.count({
        where: { profileId, registeredOnChain: false },
      })) === 0;
    return res.status(200).json({
      status: allRegistered ? 'registered' : 'frozen',
      bucketHash: profile.bucketHash,
    });
  } catch (error: any) {
    Logger.error('Failed to get mint status:', error);
    return res.status(500).json({ error: 'Failed to get mint status' });
  }
});

/**
 * GET /blockchain/my-mint-counts
 * Returns { profileId: 0|1 } per bucket the current user *created*. With
 * one-mint-per-bucket the count is always 0 or 1; map shape kept for caller
 * compatibility (Studio's mint counter chip).
 */
blockchainRouter.get('/my-mint-counts', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const minted = await userAiProfileRepository
      .createQueryBuilder('p')
      .select('p.id', 'profileId')
      .where('p.userId = :userId', { userId })
      .andWhere('p.mintedTokenId IS NOT NULL')
      .getRawMany();
    const counts: Record<string, number> = {};
    for (const r of minted) counts[r.profileId] = 1;
    return res.status(200).json({ counts });
  } catch (error: any) {
    Logger.error('Failed to get mint counts:', error);
    return res.status(500).json({ error: 'Failed to get mint counts' });
  }
});

/**
 * GET /blockchain/my-nfts
 * Mint-side ownership view. Returns immutable buckets the caller created
 * AND still controls — pending mints (frozen but tx unconfirmed) and minted
 * buckets the wallet currently holds the NFT for.
 *
 * Sold buckets (creator transferred the NFT) are intentionally omitted —
 * they're no longer the caller's to act on and would just add clutter.
 *
 *   frozen     — isImmutable, tx1 not yet landed; cancel allowed
 *   registered — tx1 confirmed (contexts on-chain), awaiting tx2; can resume mint
 *   minted     — tokenId set AND wallet still holds the NFT
 */
blockchainRouter.get('/my-nfts', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const profiles = await userAiProfileRepository.find({
      where: { userId, isImmutable: true },
      order: { mintedAt: 'DESC', createdAt: 'DESC' },
    });
    if (profiles.length === 0) return res.status(200).json({ nfts: [] });

    const held = authAddress ? await walletToBucketHashes(authAddress) : new Set<string>();

    // Pending profiles need a 4-state breakdown so the UI can branch between
    // "cancel" (frozen) and "resume mint" (registered). Two batch queries:
    // total context count per profile, and how many of those are not yet
    // registered on-chain. Avoids N+1 over the pending set.
    const pendingProfileIds = profiles
      .filter((p) => !p.mintedTokenId)
      .map((p) => p.id);
    const totalCounts: Record<string, number> = {};
    const unregisteredCounts: Record<string, number> = {};
    if (pendingProfileIds.length > 0) {
      const totals = await userContextRepository
        .createQueryBuilder('c')
        .select('c.profileId', 'profileId')
        .addSelect('COUNT(*)', 'count')
        .where('c.profileId IN (:...ids)', { ids: pendingProfileIds })
        .groupBy('c.profileId')
        .getRawMany<{ profileId: string; count: string }>();
      for (const r of totals) totalCounts[r.profileId] = parseInt(r.count, 10);

      const unreg = await userContextRepository
        .createQueryBuilder('c')
        .select('c.profileId', 'profileId')
        .addSelect('COUNT(*)', 'count')
        .where('c.profileId IN (:...ids)', { ids: pendingProfileIds })
        .andWhere('c.registeredOnChain = :reg', { reg: false })
        .groupBy('c.profileId')
        .getRawMany<{ profileId: string; count: string }>();
      for (const r of unreg) unregisteredCounts[r.profileId] = parseInt(r.count, 10);
    }

    type Status = 'frozen' | 'registered' | 'minted';
    const nfts: Array<ReturnType<typeof serializeBucketAsNft> & { mintStatus: Status }> = [];
    for (const p of profiles) {
      if (!p.mintedTokenId) {
        // "registered" requires bucketHash AND at least one context, ALL of
        // which are on-chain. An empty bucket with a stale bucketHash (e.g.,
        // leftover from a wipe or a bug) must NOT report 'registered' — that
        // would offer a Resume button that mintBucket() will reject.
        const total = totalCounts[p.id] ?? 0;
        const unregistered = unregisteredCounts[p.id] ?? 0;
        const status: Status =
          p.bucketHash && total > 0 && unregistered === 0 ? 'registered' : 'frozen';
        nfts.push({ ...serializeBucketAsNft(p), mintStatus: status });
      } else if (p.bucketHash && held.has(p.bucketHash.toLowerCase())) {
        nfts.push({ ...serializeBucketAsNft(p), mintStatus: 'minted' });
      }
      // Sold → skipped.
    }
    return res.status(200).json({ nfts });
  } catch (error: any) {
    Logger.error('Failed to get my NFTs:', error);
    return res.status(500).json({ error: 'Failed to get NFTs' });
  }
});

/**
 * GET /blockchain/acquired-nfts
 * NFTs currently held but NOT originally created by the caller.
 */
blockchainRouter.get('/acquired-nfts', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    if (!authAddress) return res.status(200).json({ nfts: [] });

    const held = await walletToBucketHashes(authAddress);
    if (held.size === 0) return res.status(200).json({ nfts: [] });

    const profiles = await userAiProfileRepository
      .createQueryBuilder('p')
      .where('p.userId != :userId', { userId })
      .andWhere('p.isImmutable = true')
      .andWhere('LOWER(p.bucketHash) IN (:...hashes)', { hashes: Array.from(held) })
      .orderBy('p.mintedAt', 'DESC')
      .getMany();

    return res.status(200).json({ nfts: profiles.map(serializeBucketAsNft) });
  } catch (error: any) {
    Logger.error('Failed to get acquired NFTs:', error);
    return res.status(500).json({ error: 'Failed to get NFTs' });
  }
});

// Public-facing JSON for an immutable bucket. Never includes raw content —
// only counts and metadata. Matches the legacy snapshot shape just enough
// that the Studio UI's NFT cards keep rendering during the rewrite.
function serializeBucketAsNft(p: UserAiProfile) {
  return {
    id: p.id,
    tokenId: p.mintedTokenId,
    profileId: p.id,
    profileName: p.profileName,
    profileImage: p.image,
    title: p.nftTitle,
    tagline: p.nftTagline,
    description: p.nftDescription,
    coverImage: p.nftCoverImage,
    bucketHash: p.bucketHash,
    metadataURI: buildBucketMetadataURI(p.id),
    mintTxHash: p.mintTxHash,
    chain: 'oasis-sapphire-testnet',
    listingActive: p.listingActive,
    listingPrice: p.listingPrice,
    mintedAt: p.mintedAt?.toISOString(),
    createdAt: p.createdAt.toISOString(),
  };
}

// Helper: find the UserAiProfile that owns a given on-chain tokenId.
// One profile per token (mintedTokenId is set once at /mint/confirm and never
// changes); if multiple ever existed it's a data bug and we take the most
// recently minted one.
async function findProfileByTokenId(tokenId: number) {
  return userAiProfileRepository.findOne({
    where: { mintedTokenId: tokenId },
    order: { mintedAt: 'DESC' },
  });
}

/**
 * POST /blockchain/list/:tokenId
 * Verify on-chain Listed event, then mirror state onto profile.
 */
blockchainRouter.post('/list/:tokenId', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const authAddress = req?.user?.authAddress;
    const { tokenId } = req.params;
    const { price, txHash } = req.body;

    if (!authAddress) return res.status(400).json({ error: 'Wallet address required' });
    const tid = parseInt(tokenId);
    if (typeof price !== 'string' || !/^\d+$/.test(price)) {
      return res.status(400).json({ error: 'price must be a wei string' });
    }

    const verifyError = await verifyTxEvent({
      txHash,
      tokenId: tid,
      expectEvent: 'Listed',
      expectActor: authAddress,
      actorRole: 'from',
      expectPrice: price,
    });
    if (verifyError) {
      Logger.warn(`[LIST] reject for ${authAddress} on #${tid}: ${verifyError}`);
      return res.status(403).json({ error: verifyError });
    }

    const profile = await findProfileByTokenId(tid);
    if (!profile) return res.status(404).json({ error: 'Bucket for token not found' });

    profile.listingActive = true;
    profile.listingPrice = price;
    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await userAiProfileRepository.save(profile);

    return res.status(200).json({ success: true, tokenId: tid, price });
  } catch (error: any) {
    Logger.error('Failed to record listing:', error);
    return res.status(500).json({ error: 'Failed to record listing' });
  }
});

/**
 * POST /blockchain/delist/:tokenId
 * Verify on-chain Delisted event, then mirror state onto profile.
 */
blockchainRouter.post('/delist/:tokenId', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const authAddress = req?.user?.authAddress;
    const { tokenId } = req.params;
    const { txHash } = req.body;

    if (!authAddress) return res.status(400).json({ error: 'Wallet address required' });
    const tid = parseInt(tokenId);

    const verifyError = await verifyTxEvent({
      txHash,
      tokenId: tid,
      expectEvent: 'Delisted',
      expectActor: authAddress,
      actorRole: 'from',
    });
    if (verifyError) {
      Logger.warn(`[DELIST] reject for ${authAddress} on #${tid}: ${verifyError}`);
      return res.status(403).json({ error: verifyError });
    }

    const profile = await findProfileByTokenId(tid);
    if (!profile) return res.status(404).json({ error: 'Bucket for token not found' });

    profile.listingActive = false;
    profile.listingPrice = null;
    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await userAiProfileRepository.save(profile);

    return res.status(200).json({ success: true, tokenId: tid });
  } catch (error: any) {
    Logger.error('Failed to record delisting:', error);
    return res.status(500).json({ error: 'Failed to record delisting' });
  }
});

/**
 * POST /blockchain/buy/:tokenId
 * Verify on-chain Sold event, mirror state onto profile, invalidate both
 * wallets' NFT caches. No data import — the bucket data IS the bucket.
 *
 * After this call:
 *   - The buyer's PAT/cookie sees the bucket via NFT-derived access on the
 *     next request (cache miss → re-read chain → bucketHash matches → 200).
 *   - The seller's next read returns 404 (their cache was just busted, the
 *     re-read won't find the hash, permission flips to "no access").
 */
blockchainRouter.post('/buy/:tokenId', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const authAddress = req?.user?.authAddress;
    const { tokenId } = req.params;
    const { txHash } = req.body;

    if (!authAddress) return res.status(400).json({ error: 'Wallet address required' });
    const tid = parseInt(tokenId);

    const verifyError = await verifyTxEvent({
      txHash,
      tokenId: tid,
      expectEvent: 'Sold',
      expectActor: authAddress,
      actorRole: 'to',
    });
    if (verifyError) {
      Logger.warn(`[BUY] reject for ${authAddress} on #${tid}: ${verifyError}`);
      return res.status(403).json({ error: verifyError });
    }

    const profile = await findProfileByTokenId(tid);
    if (!profile) return res.status(404).json({ error: 'Bucket for token not found' });

    // Find the seller address from the Sold event to invalidate their cache too.
    const client = getContractClient();
    const events = await client.getEventsFromTx(txHash, tid);
    const sold = events.find((e) => e.event === 'Sold');
    const sellerWallet = sold?.from;

    profile.listingActive = false;
    profile.listingPrice = null;
    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await userAiProfileRepository.save(profile);

    invalidateWalletNftCache(authAddress);
    if (sellerWallet) invalidateWalletNftCache(sellerWallet);

    Logger.info(`NFT #${tid} purchased by ${authAddress}, tx: ${txHash}`);
    return res.status(200).json({ success: true, tokenId: tid, newOwner: authAddress });
  } catch (error: any) {
    Logger.error('Failed to record purchase:', error);
    return res.status(500).json({ error: 'Failed to record purchase' });
  }
});

// /import-snapshot is gone: the NFT is the bucket, no copy needed. Buyers
// see the bucket immediately via NFT-derived permission (Phase 5).

/**
 * GET /blockchain/history/:tokenId
 * Replay marketplace events for a token by parsing each tx receipt we've
 * recorded on its profile. Sapphire log queries are too restricted for a
 * generic event scan; profile.transactionHashes is our index.
 */
blockchainRouter.get('/history/:tokenId', async (req: Request, res: Response) => {
  try {
    const { tokenId } = req.params;
    const tid = parseInt(tokenId);

    const client = getContractClient();
    if (!client.isConfigured()) return res.status(200).json({ history: [] });

    const profile = await findProfileByTokenId(tid);
    if (!profile) return res.status(200).json({ history: [] });

    const txHashes = new Set<string>();
    if (profile.mintTxHash) txHashes.add(profile.mintTxHash);
    for (const h of profile.transactionHashes || []) txHashes.add(h);

    const allEvents: Array<{
      event: string;
      from?: string;
      to?: string;
      price?: string;
      bucketHash?: string;
      txHash: string;
      timestamp: string;
      blockNumber: number;
    }> = [];
    for (const txHash of txHashes) {
      const events = await client.getEventsFromTx(txHash, tid);
      allEvents.push(...events);
    }
    allEvents.sort((a, b) => a.blockNumber - b.blockNumber);
    const seen = new Set<string>();
    const history = allEvents.filter((e) => {
      const key = `${e.event}-${e.txHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ history });
  } catch (error: any) {
    Logger.error('Failed to get NFT history:', error);
    return res.status(500).json({ error: 'Failed to get history' });
  }
});

/**
 * GET /blockchain/marketplace/listings
 * Active listings — public, anyone can browse. Sourced from
 * user_ai_profile where listingActive=true AND isImmutable=true.
 */
blockchainRouter.get('/marketplace/listings', async (req: Request, res: Response) => {
  try {
    const profiles = await userAiProfileRepository.find({
      where: { listingActive: true, isImmutable: true },
      order: { mintedAt: 'DESC' },
    });
    return res.status(200).json({ listings: profiles.map(serializeBucketAsNft) });
  } catch (error: any) {
    Logger.error('Failed to get marketplace listings:', error);
    return res.status(500).json({ error: 'Failed to get listings' });
  }
});

/**
 * Build a content-hash for a context row, falling back to recomputing from
 * raw content if the live row never had one. Returns null when the AI
 * service can't be reached either. Idempotent — also writes the resolved
 * hash back to the row so we don't pay this cost twice.
 */
async function resolveContextHash(context: UserContext): Promise<string | null> {
  if (context.contentHash) return context.contentHash;
  try {
    const profile = await userAiProfileRepository.findOne({
      where: { id: context.profileId },
      select: ['userId'],
    });
    if (!profile) return null;
    const aiResponse = await axios.get(`${process.env.AI_SERVICE_URL}/rag/get-context-data`, {
      params: { userId: profile.userId, contextId: context.contextId, startChunk: 0, limit: 10000 },
      headers: { 'X-API-Key': process.env.AI_SERVICE_API_KEY as string },
    });
    const rawContent: string = aiResponse.data?.content || '';
    if (!rawContent) return null;
    const clean = rawContent.replace(/^Title:\s*.*?\n\s*Content:\s*/s, '').trim();
    if (!clean) return null;
    const hash = hashContent(clean);
    context.contentHash = hash;
    await userContextRepository.save(context);
    return hash;
  } catch (err) {
    Logger.warn(`[register-context] AI fetch fallback failed for ${context.contextId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * GET /blockchain/verify/:contextId
 * Verify content provenance on-chain (view call, no gas).
 */
blockchainRouter.get('/verify/:contextId', async (req: Request, res: Response) => {
  try {
    const { contextId } = req.params;

    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }

    const context = await userContextRepository.findOne({ where: { contextId } });
    if (!context) {
      return res.status(404).json({ error: 'Context not found' });
    }

    // user_context.contentHash is the authoritative source post-rewrite
    // (Phase 3 stamps it on every write). No snapshot fallback needed.
    const contentHash = context.contentHash || null;

    if (!contentHash || !context.registeredOnChain) {
      return res.status(200).json({
        verified: false,
        reason: 'Context not registered on-chain',
      });
    }

    const isValid = await client.verifyContent(contextId, contentHash);

    return res.status(200).json({
      verified: isValid,
      contentHash,
      registryTxHash: context.registryTxHash,
      registeredOnChain: context.registeredOnChain,
    });
  } catch (error: any) {
    Logger.error('Failed to verify content:', error);
    return res.status(500).json({ error: 'Failed to verify content' });
  }
});

/**
 * GET /blockchain/bucket/:profileId/on-chain
 * Get on-chain data for a bucket.
 */
blockchainRouter.get('/bucket/:profileId/on-chain', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const { profileId } = req.params;

    const client = getContractClient();
    if (!client.isConfigured()) {
      return res.status(503).json({ error: 'Blockchain service not configured' });
    }

    // One token per bucket — read directly from the profile.
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId },
      select: ['mintedTokenId', 'mintTxHash', 'mintedAt', 'bucketHash'],
    });
    if (!profile?.mintedTokenId) {
      return res.status(200).json({ minted: false, mintCount: 0 });
    }
    return res.status(200).json({
      minted: true,
      mintCount: 1,
      latestTokenId: profile.mintedTokenId,
      bucketHash: profile.bucketHash,
      mints: [
        {
          tokenId: profile.mintedTokenId,
          txHash: profile.mintTxHash,
          mintedAt: profile.mintedAt?.toISOString(),
        },
      ],
    });
  } catch (error: any) {
    Logger.error('Failed to get on-chain data:', error);
    return res.status(500).json({ error: 'Failed to get on-chain data' });
  }
});
