import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique } from 'typeorm';

/**
 * A marketplace listing for a specific (tokenId, seller) pair.
 *
 * With limited editions (supply-N per bucket) a token can have several holders,
 * each listing a portion of their copies at their own per-unit price. The
 * on-chain contract keys listings by (tokenId, seller); this table mirrors that
 * for fast marketplace queries (Sapphire log queries are range-limited). It is
 * kept in sync by /blockchain/list, /delist, /buy after the on-chain event is
 * verified — every field is derived from the verified event, not trusted input.
 *
 * One active row per (tokenId, seller); `amount` is decremented as copies sell.
 */
@Entity('nft_listing')
@Unique(['tokenId', 'seller'])
export class NftListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'int' })
  tokenId: number;

  // The bucket (user_ai_profile.id) this token belongs to. Denormalized so the
  // marketplace can join listing → bucket metadata without a token→profile hop.
  @Index()
  @Column({ type: 'uuid' })
  profileId: string;

  // Seller wallet, lowercased.
  @Index()
  @Column({ type: 'text' })
  seller: string;

  // Per-unit price in wei (decimal string).
  @Column({ type: 'varchar', length: 78 })
  price: string;

  // Units currently listed (decremented on partial buys; 0 ⇒ inactive).
  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
