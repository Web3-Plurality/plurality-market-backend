import express, { Request, Response } from 'express';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { AppDataSource } from '../../../data-source';
import { In } from 'typeorm';
import { UserAiProfile } from '../../ai-service/entity/user-ai-profile';
import { UserContext } from '../../ai-service/entity/user-context';
import { NftListing } from '../entity/nft-listing';
import { resolveProfileAccess } from '../../ai-service/utils/permission';
import { computeFromProfile as previewBucketHash } from '../../ai-service/utils/bucket-hash';
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
const nftListingRepository = AppDataSource.getRepository(NftListing);

// Recompute the bucket-level listing summary on user_ai_profile from the
// authoritative per-(token,seller) rows in nft_listing: listingActive = any
// active listing exists; listingPrice = the current floor (min per-unit price).
// Keeps serializeBucketAsNft (and any legacy consumer) truthful without a join.
async function refreshListingSummary(profile: UserAiProfile, tokenId: number): Promise<void> {
  const active = await nftListingRepository.find({ where: { tokenId, active: true } });
  if (active.length === 0) {
    profile.listingActive = false;
    profile.listingPrice = null;
  } else {
    profile.listingActive = true;
    profile.listingPrice = active
      .map((l) => BigInt(l.price))
      .reduce((min, p) => (p < min ? p : min))
      .toString();
  }
  await userAiProfileRepository.save(profile);
}

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

    // Compute the bucketHash from current contexts WITHOUT persisting yet.
    // We need the hash for the on-chain pre-check; persisting happens in a
    // single coordinated save below so it can't race with isImmutable.
    const bucketHash = await previewBucketHash(profileId);
    if (!bucketHash) {
      return res.status(400).json({
        error: 'empty_bucket',
        message: 'Cannot mint an empty bucket — add at least one context first.',
      });
    }

    // Has on-chain registration already landed for this content? Self-heals
    // a stuck state where a prior prepare-registration call partially
    // persisted (e.g. left isImmutable=true but lost the bucketHash) — we
    // restore the DB row to a consistent prepared/registered state and
    // tell the caller to advance to /prepare-mint.
    const registrant = await client.getBucketRegistrant(bucketHash);
    const callerWallet = (req?.user?.authAddress || '').toLowerCase();
    if (registrant !== '0x0000000000000000000000000000000000000000') {
      if (callerWallet && registrant !== callerWallet) {
        return res.status(403).json({
          error: 'bucket_claimed_by_another_wallet',
          message: 'This bucketHash is registered to a different wallet.',
          registrant,
        });
      }
      // Heal the DB row if the previous prepare-registration call lost the
      // hash or didn't flip immutable.
      profile.bucketHash = bucketHash;
      profile.isImmutable = true;
      await userAiProfileRepository.save(profile);
      return res.status(409).json({
        error: 'already_registered',
        message: 'Contexts already on-chain. Proceed to /prepare-mint.',
        bucketHash,
      });
    }

    // Stamp NFT presentation metadata + freeze the bucket + persist the
    // bucketHash in a SINGLE save. Splitting these across multiple saves
    // (or relying on recomputeAndStore's own internal save) created a
    // stale-write race that could nuke the bucketHash after persistence.
    const meta = sanitizeMintMetadata(req.body);
    profile.nftTitle = meta.title || profile.profileName;
    profile.nftTagline = meta.tagline;
    profile.nftDescription = meta.description;
    profile.nftCoverImage = meta.coverImage || profile.image || null;
    profile.bucketHash = bucketHash;
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

    // Edition size (number of copies) the creator wants to mint, 1..MAX_COPIES.
    // Defaults to 1 for backward-compatible callers.
    const copies = Number((req.body as { copies?: number })?.copies ?? 1);
    if (!Number.isInteger(copies) || copies < 1 || copies > 10) {
      return res.status(400).json({ error: 'copies must be an integer in [1, 10]' });
    }

    const metadataURI = buildBucketMetadataURI(profileId);
    const callData = client.prepareMintData(profile.bucketHash, metadataURI, copies);
    const mintFee = await client.getMintFee();

    return res.status(200).json({
      profileId,
      bucketHash: profile.bucketHash,
      metadataURI,
      copies,
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
    // Edition size straight from the on-chain event (authoritative). Older
    // single-copy mints (or a missing field) fall back to 1.
    profile.editionSize = minted.copies && minted.copies >= 1 ? minted.copies : 1;
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
    // Frozen → check whether tx1 (registration) already landed. Source of
    // truth is registeredOnChain flags on user_context (set by
    // /confirm-registration). If the flags are still false but the chain
    // actually has the registration, self-heal here so the UI can advance
    // to "Resume mint" without a manual recovery step.
    let bucketHash: string | null = profile.bucketHash || null;
    let allRegistered =
      !!bucketHash &&
      (await userContextRepository.count({
        where: { profileId, registeredOnChain: false },
      })) === 0;

    if (!allRegistered) {
      // Self-heal probe. Two stuck states we want to recover from:
      //   (a) bucketHash IS persisted but registeredOnChain flags weren't
      //       flipped (confirm-registration never landed).
      //   (b) bucketHash is NULL because a prior prepare-registration save
      //       raced and nuked it. The bucket is isImmutable=true here so
      //       recomputing from contents gives the EXACT hash tx1 would have
      //       used — content can't have changed.
      // In both cases, a non-zero on-chain registrant proves tx1 landed.
      try {
        const client = getContractClient();
        if (client.isConfigured()) {
          if (!bucketHash) {
            bucketHash = await previewBucketHash(profileId);
          }
          if (bucketHash) {
            const registrant = await client.getBucketRegistrant(bucketHash);
            if (registrant !== '0x0000000000000000000000000000000000000000') {
              // Persist a missing bucketHash so prepare-mint / confirm-mint
              // can use it without re-probing.
              if (!profile.bucketHash) {
                profile.bucketHash = bucketHash;
                await userAiProfileRepository.save(profile);
              }
              // Mark every still-unmarked context as on-chain.
              await userContextRepository.update({ profileId, registeredOnChain: false }, { registeredOnChain: true });
              allRegistered = true;
            }
          }
        }
      } catch (err) {
        Logger.warn(`[status] self-heal probe failed for ${profileId}:`, err);
      }
    }

    return res.status(200).json({
      status: allRegistered ? 'registered' : 'frozen',
      bucketHash,
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
    // "cancel" (frozen) and "resume mint" (registered). One batch query for
    // total context counts (used for both the frozen/registered split AND
    // the card-front "N contexts" badge for every NFT in the response), and
    // a narrower one for the unregistered subset. Avoids N+1 across the set.
    const allProfileIds = profiles.map((p) => p.id);
    const pendingProfileIds = profiles.filter((p) => !p.mintedTokenId).map((p) => p.id);
    const totalCounts = await countContextsByProfile(allProfileIds);
    const unregisteredCounts: Record<string, number> = {};
    if (pendingProfileIds.length > 0) {
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

    // Resolve the contract client once. Used for self-heal probes on stuck
    // pending mints: if tx1 actually landed on chain but DB lost track (lost
    // bucketHash, registeredOnChain flags never flipped), we want the UI to
    // show "Resume mint" not "Cancel".
    const client = getContractClient();
    const clientReady = client.isConfigured();

    for (const p of profiles) {
      if (!p.mintedTokenId) {
        // "registered" requires bucketHash AND at least one context, ALL of
        // which are on-chain. An empty bucket with a stale bucketHash (e.g.,
        // leftover from a wipe or a bug) must NOT report 'registered' — that
        // would offer a Resume button that mintBucket() will reject.
        const total = totalCounts[p.id] ?? 0;
        const unregistered = unregisteredCounts[p.id] ?? 0;
        let status: Status = p.bucketHash && total > 0 && unregistered === 0 ? 'registered' : 'frozen';

        // Self-heal probe: if we're about to call this 'frozen' but the chain
        // actually has the registration, fix DB + report 'registered'. Covers
        // two failure modes:
        //   (a) bucketHash persisted, registeredOnChain flags weren't flipped
        //   (b) bucketHash got overwritten to null by a stale-save race; the
        //       hash is deterministic from content (which can't change while
        //       isImmutable=true), so we can recompute it safely
        if (status === 'frozen' && total > 0 && clientReady) {
          try {
            const hash = p.bucketHash || (await previewBucketHash(p.id));
            if (hash) {
              const registrant = await client.getBucketRegistrant(hash);
              if (registrant !== '0x0000000000000000000000000000000000000000') {
                if (!p.bucketHash) {
                  p.bucketHash = hash;
                  await userAiProfileRepository.save(p);
                }
                await userContextRepository.update(
                  { profileId: p.id, registeredOnChain: false },
                  { registeredOnChain: true },
                );
                status = 'registered';
              }
            }
          } catch (err) {
            Logger.warn(`[my-nfts] self-heal probe failed for ${p.id}:`, err);
          }
        }

        nfts.push({ ...serializeBucketAsNft(p, totalCounts[p.id] ?? 0), mintStatus: status });
      } else if (p.bucketHash && held.has(p.bucketHash.toLowerCase())) {
        nfts.push({ ...serializeBucketAsNft(p, totalCounts[p.id] ?? 0), mintStatus: 'minted' });
      }
      // Sold → skipped.
    }
    return res.status(200).json({ nfts: await attachCallerListings(nfts, authAddress) });
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

    const counts = await countContextsByProfile(profiles.map((p) => p.id));
    const serialized = profiles.map((p) => serializeBucketAsNft(p, counts[p.id] ?? 0));
    return res.status(200).json({ nfts: await attachCallerListings(serialized, authAddress) });
  } catch (error: any) {
    Logger.error('Failed to get acquired NFTs:', error);
    return res.status(500).json({ error: 'Failed to get NFTs' });
  }
});

// Attach the CALLER's own active listing to each serialized NFT. The bucket
// listingActive means "SOMEONE has a listing"; My-Minted / Acquired need "do
// *I* have a listing" to show List vs Delist. Sourced from nft_listing keyed
// by (tokenId, seller=caller). Without this, a buyer sees the seller's residual
// bucket-level listing state as if it were their own.
async function attachCallerListings<T extends { tokenId: number | null }>(
  nfts: T[],
  callerWallet: string | undefined,
): Promise<
  (T & {
    myListingActive: boolean;
    myListingPrice: string | null;
    myListingAmount: number;
    copiesOwned: number;
  })[]
> {
  const out = nfts.map((n) => ({
    ...n,
    myListingActive: false,
    myListingPrice: null as string | null,
    myListingAmount: 0,
    copiesOwned: 0,
  }));
  if (!callerWallet) return out;
  const seller = callerWallet.toLowerCase();
  const tokenIds = out.map((n) => n.tokenId).filter((t): t is number => typeof t === 'number');
  if (tokenIds.length === 0) return out;

  const rows = await nftListingRepository.find({ where: { seller, tokenId: In(tokenIds), active: true } });
  const byToken = new Map(rows.map((r) => [r.tokenId, r] as const));

  // Copies owned per token — one batched ERC-1155 balanceOfBatch call.
  const balByToken = new Map<number, number>();
  try {
    const client = getContractClient();
    if (client.isConfigured()) {
      const balances = await client.balancesOf(callerWallet, tokenIds);
      tokenIds.forEach((t, i) => balByToken.set(t, balances[i] ?? 0));
    }
  } catch (err) {
    Logger.warn('[attachCallerListings] balanceOfBatch failed:', err);
  }

  for (const n of out) {
    if (typeof n.tokenId !== 'number') continue;
    const r = byToken.get(n.tokenId);
    if (r) {
      n.myListingActive = true;
      n.myListingPrice = r.price;
      n.myListingAmount = r.amount;
    }
    n.copiesOwned = balByToken.get(n.tokenId) ?? 0;
  }
  return out;
}

// Public-facing JSON for an immutable bucket. Never includes raw content —
// only counts and metadata. Matches the legacy snapshot shape just enough
// that the Studio UI's NFT cards keep rendering during the rewrite.
function serializeBucketAsNft(p: UserAiProfile, contextCount = 0) {
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
    editionSize: p.editionSize ?? 1,
    listingActive: p.listingActive,
    listingPrice: p.listingPrice,
    mintedAt: p.mintedAt?.toISOString(),
    createdAt: p.createdAt.toISOString(),
    // Card front shows "N contexts". Counted once per request by the calling
    // endpoint and threaded through here — N+1 over individual SELECT counts
    // would scale badly when a wallet holds many NFTs.
    contextCount,
  };
}

// Batch-count contexts per profile id. Used by every endpoint that emits
// `serializeBucketAsNft(...)` so the response carries a non-zero context
// total on the card-front display.
async function countContextsByProfile(profileIds: string[]): Promise<Record<string, number>> {
  if (profileIds.length === 0) return {};
  const rows = await userContextRepository
    .createQueryBuilder('c')
    .select('c.profileId', 'profileId')
    .addSelect('COUNT(*)', 'count')
    .where('c.profileId IN (:...ids)', { ids: profileIds })
    .groupBy('c.profileId')
    .getRawMany<{ profileId: string; count: string }>();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.profileId] = parseInt(r.count, 10);
  return out;
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
    const { txHash } = req.body;

    if (!authAddress) return res.status(400).json({ error: 'Wallet address required' });
    const tid = parseInt(tokenId);

    // Auth: the on-chain Listed event must credit the caller as the seller.
    const verifyError = await verifyTxEvent({
      txHash,
      tokenId: tid,
      expectEvent: 'Listed',
      expectActor: authAddress,
      actorRole: 'from',
    });
    if (verifyError) {
      Logger.warn(`[LIST] reject for ${authAddress} on #${tid}: ${verifyError}`);
      return res.status(403).json({ error: verifyError });
    }

    const profile = await findProfileByTokenId(tid);
    if (!profile) return res.status(404).json({ error: 'Bucket for token not found' });

    // Derive per-unit price + amount from the verified event (never trust body).
    const client = getContractClient();
    const listed = (await client.getEventsFromTx(txHash as string, tid)).find((e) => e.event === 'Listed');
    const price = listed?.price ?? '0';
    const amount = listed?.amount ?? 0;
    if (amount < 1 || !/^\d+$/.test(price) || price === '0') {
      return res.status(400).json({ error: 'Listed event missing a valid price/amount' });
    }
    const seller = authAddress.toLowerCase();

    // Upsert the (tokenId, seller) listing — one active row per seller per token.
    let listing = await nftListingRepository.findOne({ where: { tokenId: tid, seller } });
    if (!listing) {
      listing = nftListingRepository.create({ tokenId: tid, profileId: profile.id, seller });
    }
    listing.profileId = profile.id;
    listing.price = price;
    listing.amount = amount;
    listing.active = true;
    await nftListingRepository.save(listing);

    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await refreshListingSummary(profile, tid);

    return res.status(200).json({ success: true, tokenId: tid, price, amount });
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

    // Deactivate this seller's listing for the token.
    const seller = authAddress.toLowerCase();
    const listing = await nftListingRepository.findOne({ where: { tokenId: tid, seller } });
    if (listing) {
      listing.active = false;
      listing.amount = 0;
      await nftListingRepository.save(listing);
    }

    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await refreshListingSummary(profile, tid);

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

    // Derive seller + amount from the verified Sold event (never trust body).
    const client = getContractClient();
    const events = await client.getEventsFromTx(txHash as string, tid);
    const sold = events.find((e) => e.event === 'Sold');
    const sellerWallet = (sold?.from || '').toLowerCase();
    const boughtAmount = sold?.amount ?? 0;

    // Reduce the seller's listing by the units sold; deactivate when it hits 0.
    if (sellerWallet && boughtAmount > 0) {
      const listing = await nftListingRepository.findOne({ where: { tokenId: tid, seller: sellerWallet } });
      if (listing) {
        listing.amount = Math.max(0, listing.amount - boughtAmount);
        if (listing.amount === 0) listing.active = false;
        await nftListingRepository.save(listing);
      }
    }

    profile.transactionHashes = [...(profile.transactionHashes || []), txHash];
    await refreshListingSummary(profile, tid);

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
 * Public browse — ONE card per bucket that has ≥1 active listing. Each card
 * carries the floor (min per-unit price), total copies available across all
 * sellers, and the seller count. Sourced from nft_listing (the per-(token,
 * seller) rows). Use /marketplace/listings/:tokenId for the per-seller detail.
 */
blockchainRouter.get('/marketplace/listings', async (req: Request, res: Response) => {
  try {
    const active = await nftListingRepository.find({ where: { active: true } });
    if (active.length === 0) return res.status(200).json({ listings: [] });

    // Group active rows by bucket.
    const byProfile = new Map<string, NftListing[]>();
    for (const l of active) {
      const arr = byProfile.get(l.profileId) || [];
      arr.push(l);
      byProfile.set(l.profileId, arr);
    }

    const profiles = await userAiProfileRepository.find({
      where: { id: In([...byProfile.keys()]), isImmutable: true },
    });
    const counts = await countContextsByProfile(profiles.map((p) => p.id));

    const listings = profiles.map((p) => {
      const rows = byProfile.get(p.id) || [];
      const floor = rows
        .map((r) => BigInt(r.price))
        .reduce((min, x) => (x < min ? x : min))
        .toString();
      const copiesAvailable = rows.reduce((s, r) => s + r.amount, 0);
      return {
        ...serializeBucketAsNft(p, counts[p.id] ?? 0),
        listingActive: true,
        listingPrice: floor, // floor per-unit — cards show "from {floor}"
        floorPrice: floor,
        copiesAvailable,
        sellerCount: rows.length,
      };
    });

    return res.status(200).json({ listings });
  } catch (error: any) {
    Logger.error('Failed to get marketplace listings:', error);
    return res.status(500).json({ error: 'Failed to get listings' });
  }
});

/**
 * GET /blockchain/marketplace/listings/:tokenId
 * Per-seller listing detail for one bucket (the "choose a seller" view behind
 * a marketplace card). Sorted cheapest per-unit first.
 */
blockchainRouter.get('/marketplace/listings/:tokenId', async (req: Request, res: Response) => {
  try {
    const tid = parseInt(req.params.tokenId);
    if (!Number.isInteger(tid)) return res.status(400).json({ error: 'Invalid tokenId' });
    const rows = await nftListingRepository.find({ where: { tokenId: tid, active: true } });
    const sellers = rows
      .map((r) => ({ seller: r.seller, price: r.price, amount: r.amount }))
      .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
    return res.status(200).json({ tokenId: tid, sellers });
  } catch (error: any) {
    Logger.error('Failed to get token listings:', error);
    return res.status(500).json({ error: 'Failed to get token listings' });
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
