import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

/**
 * A verified-platform badge attached to a bucket by its creator.
 *
 * Provenance chain: the creator's Smart Profile private attestation on
 * Sapphire commits to a Merkle root over their connected platform accounts
 * (one salted leaf each). The creator disclosed the chosen leaves with a
 * multi-proof (sp-api /smart-profiles/disclosure); we verified it against the
 * ON-CHAIN root before writing this row (smart-profile-badges.ts), and we
 * store the proof so any third party can re-run that verification without
 * trusting us. A badge therefore says: "the wallet that owns this attestation
 * controls <platform> account <username>" — and the wallet is the bucket's
 * creator (ownership checked at write time).
 */
@Entity('bucket_badge')
@Unique(['profileId', 'platformType'])
export class BucketBadge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The bucket (user_ai_profile.id) the badge is attached to.
  @Index()
  @Column({ type: 'uuid' })
  profileId: string;

  // Attestation recipient == bucket creator wallet, lowercased.
  @Column({ type: 'text' })
  wallet: string;

  @Column({ type: 'varchar', length: 50 })
  platformType: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userPlatformId: string | null;

  @Column({ type: 'varchar', length: 66 })
  privateAttestationUID: string;

  // The EAS MerkleMultiProof as returned by sp-api — kept verbatim so anyone
  // can re-verify leaf membership against the on-chain root.
  @Column({ type: 'jsonb' })
  proof: unknown;

  @CreateDateColumn()
  createdAt: Date;
}
