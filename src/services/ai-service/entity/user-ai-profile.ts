import { Entity, Column, CreateDateColumn, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('user_ai_profile')
@Index(['bucketHash'])
export class UserAiProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column()
  profileName: string;

  @Column()
  image: string;

  @CreateDateColumn()
  createdAt: Date;

  // ── Hash-as-identity / NFT-as-access-token ─────────────────────────
  // bucketHash: SHA-256 Merkle of the bucket's contextHashes, ordered
  // (createdAt ASC, contextId ASC). NULL until the first context is added.
  // Recomputed on every context add/delete while the bucket is a draft;
  // frozen at mint time and used as the on-chain identifier.
  @Column({ type: 'varchar', length: 66, nullable: true })
  bucketHash: string | null;

  // isImmutable: false while editable (draft, creator-owned); flips to true
  // at the moment of mint and never flips back. Read access for immutable
  // buckets is gated by NFT ownership, not userId.
  @Column({ type: 'boolean', default: false })
  isImmutable: boolean;

  // On-chain reference set at /mint/confirm. NULL for drafts.
  @Column({ type: 'int', nullable: true })
  mintedTokenId: number | null;

  // Edition size (number of copies) this bucket was minted with (1..MAX_COPIES).
  // Set at /mint/confirm from the on-chain BucketMinted event. NULL for drafts.
  @Column({ type: 'int', nullable: true })
  editionSize: number | null;

  @Column({ type: 'timestamp', nullable: true })
  mintedAt: Date | null;

  // ── NFT metadata (what the on-chain tokenURI resolves to) ──────────
  // Filled by the /mint dialog and frozen at mint time. The metadata
  // endpoint /blockchain/metadata/bucket/:profileId serves these directly.
  // Distinct from profileName/image so the user can give the NFT a
  // distinct presentation without renaming the bucket.
  @Column({ type: 'varchar', length: 120, nullable: true })
  nftTitle: string | null;

  @Column({ type: 'varchar', length: 280, nullable: true })
  nftTagline: string | null;

  @Column({ type: 'text', nullable: true })
  nftDescription: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  nftCoverImage: string | null;

  // Marketplace category (OpenSea-style browse filter). One key from the
  // fixed list shared with the frontend; validated in sanitizeMintMetadata.
  @Column({ type: 'varchar', length: 40, nullable: true })
  nftCategory: string | null;

  // ── Marketplace state (mirrors on-chain listing for fast queries) ──
  // Authoritative source is on-chain; these are denormalized from /list,
  // /delist, /buy after verifyTxEvent confirms the action.
  @Column({ type: 'boolean', default: false })
  listingActive: boolean;

  @Column({ type: 'varchar', length: 78, nullable: true })
  listingPrice: string | null; // wei as decimal string

  @Column({ type: 'varchar', length: 66, nullable: true })
  mintTxHash: string | null;

  // Every list / delist / buy tx hash appended here so /history can replay
  // the chain events without scanning logs (Sapphire log queries are limited).
  @Column({ type: 'jsonb', nullable: true })
  transactionHashes: string[] | null;
}
