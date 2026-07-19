import { ethers } from 'ethers';
import PluralityMemoryNFTABI from '../abis/PluralityMemoryNFT.json';
import ContextRegistryABI from '../abis/ContextRegistry.json';
import Logger from '../../../lib/logger';
import { uuidToBytes16 } from './hash-utils';

export class ContractClient {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private memoryNFT: ethers.Contract;
  private contextRegistry: ethers.Contract;

  constructor() {
    const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
    const privateKey = process.env.BACKEND_WALLET_PRIVATE_KEY;
    const nftAddress = process.env.MEMORY_NFT_CONTRACT_ADDRESS;
    const registryAddress = process.env.CONTEXT_REGISTRY_ADDRESS;

    if (!rpcUrl || !privateKey || !nftAddress || !registryAddress) {
      Logger.warn('Blockchain configuration incomplete. On-chain features will be unavailable.');
    }

    this.provider = new ethers.JsonRpcProvider(rpcUrl || 'https://testnet.sapphire.oasis.io');
    this.signer = new ethers.Wallet(
      privateKey || '0x0000000000000000000000000000000000000000000000000000000000000001',
      this.provider,
    );
    this.memoryNFT = new ethers.Contract(nftAddress || ethers.ZeroAddress, PluralityMemoryNFTABI, this.signer);
    this.contextRegistry = new ethers.Contract(registryAddress || ethers.ZeroAddress, ContextRegistryABI, this.signer);
  }

  /**
   * Check if blockchain is properly configured.
   */
  isConfigured(): boolean {
    return !!(
      process.env.BLOCKCHAIN_RPC_URL &&
      process.env.BACKEND_WALLET_PRIVATE_KEY &&
      process.env.MEMORY_NFT_CONTRACT_ADDRESS &&
      process.env.CONTEXT_REGISTRY_ADDRESS
    );
  }

  /**
   * Get the current mint fee from the NFT contract.
   */
  async getMintFee(): Promise<string> {
    const fee = await this.memoryNFT.mintFee();
    return fee.toString();
  }

  /**
   * Get contract addresses and chain info for frontend.
   */
  async getContractInfo(): Promise<{
    nftAddress: string;
    registryAddress: string;
    reputationAddress: string;
    chainId: number;
    mintFee: string;
  }> {
    const network = await this.provider.getNetwork();
    const fee = await this.getMintFee();
    return {
      nftAddress: process.env.MEMORY_NFT_CONTRACT_ADDRESS || '',
      registryAddress: process.env.CONTEXT_REGISTRY_ADDRESS || '',
      // ERC-8004 ReputationRegistry — used by the marketplace review UI. The
      // address is already configured server-side; surface it so the frontend
      // can read/write feedback directly on-chain (no backend proxy needed).
      reputationAddress: process.env.REPUTATION_REGISTRY_ADDRESS || '',
      chainId: Number(network.chainId),
      mintFee: fee,
    };
  }

  /**
   * Prepare mint data for client-side minting.
   * Returns the encoded function data that the frontend can use to call the contract.
   *
   * The on-chain identifier is now the bucketHash (bytes32) — backend computes
   * it from the bucket's contexts and freezes the bucket immutable before
   * returning. The user signs a transaction that mints an NFT bound to that
   * exact hash; any subsequent edit would change the hash, so freezing first
   * is what makes the hash on-chain match the hash in Postgres.
   */
  prepareMintData(
    bucketHash: string,
    metadataURI: string,
    copies: number,
  ): {
    to: string;
    data: string;
    value: string;
  } {
    if (!bucketHash.startsWith('0x') || bucketHash.length !== 66) {
      throw new Error(`prepareMintData: bucketHash must be 0x-prefixed 64-hex, got "${bucketHash}"`);
    }
    if (!Number.isInteger(copies) || copies < 1 || copies > 10) {
      throw new Error(`prepareMintData: copies must be an integer in [1, 10], got "${copies}"`);
    }
    const iface = new ethers.Interface(PluralityMemoryNFTABI as any);
    const data = iface.encodeFunctionData('mintBucket', [bucketHash, metadataURI, copies]);

    return {
      to: process.env.MEMORY_NFT_CONTRACT_ADDRESS || '',
      data,
      value: '0', // Frontend will read mintFee and set value
    };
  }

  /**
   * Batch-read a wallet's balance across several tokenIds in ONE call
   * (ERC-1155 balanceOfBatch). Returns counts in the same order as `tokenIds`.
   * Used to show "copies you own" per NFT on the My-Minted / Acquired cards.
   */
  async balancesOf(wallet: string, tokenIds: number[]): Promise<number[]> {
    if (tokenIds.length === 0) return [];
    const accounts = tokenIds.map(() => wallet);
    const res: bigint[] = await this.memoryNFT.balanceOfBatch(accounts, tokenIds);
    return res.map((b) => Number(b));
  }

  /**
   * Get token ID from a mint transaction receipt.
   */
  async getTokenIdFromTx(txHash: string): Promise<number | null> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) return null;

      const iface = new ethers.Interface(PluralityMemoryNFTABI as any);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed && parsed.name === 'BucketMinted') {
            return Number(parsed.args.tokenId);
          }
        } catch {
          // Not our event, skip
        }
      }
      return null;
    } catch (error) {
      Logger.error('Failed to parse mint tx:', error);
      return null;
    }
  }

  /**
   * Encode a `registerContextBatch(bucketHash, contextIds[], contentHashes[],
   * metadataURIs[], sourceTypes[])` call. One MetaMask signature publishes
   * every context of a bucket on-chain. The first signer to use a bucketHash
   * claims it — the NFT contract later requires `msg.sender` to equal that
   * registrant when calling `mintBucket`.
   */
  prepareRegisterContextBatch(
    bucketHash: string,
    contextIds: string[],
    contentHashes: string[],
    metadataURIs: string[],
    sourceTypes: string[],
  ): { to: string; data: string } {
    if (contextIds.length === 0) throw new Error('prepareRegisterContextBatch: empty batch');
    if (
      contentHashes.length !== contextIds.length ||
      metadataURIs.length !== contextIds.length ||
      sourceTypes.length !== contextIds.length
    ) {
      throw new Error('prepareRegisterContextBatch: array length mismatch');
    }
    if (!bucketHash.startsWith('0x') || bucketHash.length !== 66) {
      throw new Error(`prepareRegisterContextBatch: bucketHash must be 0x-prefixed 64-hex, got "${bucketHash}"`);
    }
    const ids = contextIds.map((id) => uuidToBytes16(id));
    const iface = new ethers.Interface(ContextRegistryABI as any);
    const data = iface.encodeFunctionData('registerContextBatch', [
      bucketHash,
      ids,
      contentHashes,
      metadataURIs,
      sourceTypes,
    ]);
    return { to: process.env.CONTEXT_REGISTRY_ADDRESS || '', data };
  }

  /**
   * Verify content hash on-chain (view call, no gas).
   */
  async verifyContent(contextId: string, contentHash: string): Promise<boolean> {
    const contextIdBytes = uuidToBytes16(contextId);
    return this.contextRegistry.verifyContent(contextIdBytes, contentHash);
  }

  /**
   * Who registered the contexts under a given bucketHash? `address(0)` if
   * no one has yet. The NFT contract enforces `msg.sender === registrant`
   * at mint time; this view lets the backend pre-check before signing.
   */
  async getBucketRegistrant(bucketHash: string): Promise<string> {
    const addr: string = await this.contextRegistry.getBucketRegistrant(bucketHash);
    return addr.toLowerCase();
  }

  /**
   * Get every contextId registered under a bucketHash. Backend uses this
   * to confirm a batch registration tx landed on-chain.
   */
  async getContextsByBucketHash(bucketHash: string): Promise<string[]> {
    const ids: string[] = await this.contextRegistry.getContextsByBucketHash(bucketHash);
    return ids;
  }

  /**
   * Get provenance info for a content hash.
   */
  async getProvenanceByHash(contentHash: string): Promise<{
    contextId: string;
    registeredAt: number;
    registeredBy: string;
    bucketHash: string;
  }> {
    const result = await this.contextRegistry.getProvenanceByHash(contentHash);
    return {
      contextId: result[0],
      registeredAt: Number(result[1]),
      registeredBy: result[2],
      bucketHash: result[3],
    };
  }

  /**
   * Get every bucketHash the given wallet currently holds an NFT for.
   * This is the chain-of-truth lookup behind the permission resolver —
   * an immutable bucket is readable iff its bucketHash appears in this set.
   * Returned hashes are lowercase 0x-prefixed 64-hex (bytes32).
   */
  async getBucketHashesByOwner(address: string): Promise<string[]> {
    const raw: string[] = await this.memoryNFT.getBucketHashesByOwner(address);
    return raw.map((h) => h.toLowerCase());
  }

  /**
   * Get token URI (metadata URI) for a token.
   */
  async getTokenURI(tokenId: number): Promise<string> {
    return this.memoryNFT.uri(tokenId);
  }

  /**
   * Get the bucket context count on-chain.
   */
  async getBucketContextCount(bucketTokenId: number): Promise<number> {
    return Number(await this.contextRegistry.getBucketContextCount(bucketTokenId));
  }

  /**
   * Get event history for a token by parsing transaction receipts.
   * Works on Oasis Sapphire which has strict log query limits.
   */
  async getEventsFromTx(
    txHash: string,
    tokenId: number,
  ): Promise<
    Array<{
      event: string;
      from?: string;
      to?: string;
      price?: string;
      amount?: number;
      bucketHash?: string;
      copies?: number;
      txHash: string;
      timestamp: string;
      blockNumber: number;
    }>
  > {
    const events: Array<{
      event: string;
      from?: string;
      to?: string;
      price?: string;
      amount?: number;
      bucketHash?: string;
      copies?: number;
      txHash: string;
      timestamp: string;
      blockNumber: number;
    }> = [];

    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) return events;

      const block = await this.provider.getBlock(receipt.blockNumber);
      const timestamp = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString();

      const iface = new ethers.Interface(PluralityMemoryNFTABI as any);

      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (!parsed) continue;

          // Only include events for our tokenId
          const logTokenId = parsed.args.tokenId !== undefined ? Number(parsed.args.tokenId) : null;
          if (logTokenId !== null && logTokenId !== tokenId) continue;

          switch (parsed.name) {
            case 'BucketMinted':
              events.push({
                event: 'Minted',
                to: parsed.args.creator,
                bucketHash: String(parsed.args.bucketHash).toLowerCase(),
                copies: parsed.args.copies !== undefined ? Number(parsed.args.copies) : undefined,
                txHash,
                timestamp,
                blockNumber: receipt.blockNumber,
              });
              break;
            case 'BucketListed':
              events.push({
                event: 'Listed',
                from: parsed.args.seller,
                price: parsed.args.price.toString(), // per-unit
                amount: parsed.args.amount !== undefined ? Number(parsed.args.amount) : undefined,
                txHash,
                timestamp,
                blockNumber: receipt.blockNumber,
              });
              break;
            case 'BucketDelisted':
              events.push({
                event: 'Delisted',
                from: parsed.args.seller,
                txHash,
                timestamp,
                blockNumber: receipt.blockNumber,
              });
              break;
            case 'BucketSold':
              events.push({
                event: 'Sold',
                from: parsed.args.seller,
                to: parsed.args.buyer,
                price: parsed.args.unitPrice.toString(), // per-unit (renamed from `price`)
                amount: parsed.args.amount !== undefined ? Number(parsed.args.amount) : undefined,
                txHash,
                timestamp,
                blockNumber: receipt.blockNumber,
              });
              break;
          }
        } catch {
          // Not our event
        }
      }
    } catch (err) {
      Logger.warn(`Failed to parse tx ${txHash}:`, err);
    }

    return events;
  }

  /**
   * Revoke a context on-chain (soft-delete).
   */
  async revokeContext(contextId: string): Promise<ethers.TransactionResponse> {
    const contextIdBytes = uuidToBytes16(contextId);
    return this.contextRegistry.revokeContext(contextIdBytes);
  }
}

// Singleton instance
let contractClientInstance: ContractClient | null = null;

export function getContractClient(): ContractClient {
  if (!contractClientInstance) {
    contractClientInstance = new ContractClient();
  }
  return contractClientInstance;
}
