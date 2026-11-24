import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from 'typeorm';

/**
 * Daily search-usage counter per subject (wallet address or client IP).
 *
 * Anti-abuse for /mcp semantic-search: embeddings are local and there is no
 * chat LLM in the stack any more, but each search still fans out one vector
 * query per owned/held bucket — real compute. Wallets are free to
 * mass-create (Sybil), so the wallet cap alone only bounds the per-account
 * volume — the IP cap is what bounds one machine scripting many wallets.
 * ('wallet'/'ip' rows from the retired per-save LLM quota may linger in old
 * databases; they are dead data, never read.)
 *
 * Rows are tiny and keyed by day; no cleanup job needed at this scale.
 */
@Entity('daily_llm_usage')
@Unique(['subjectType', 'subject', 'day'])
export class DailyLlmUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  subjectType: 'wallet_search' | 'ip_search';

  @Index()
  @Column({ type: 'varchar', length: 64 })
  subject: string;

  // Calendar date (UTC) the counter belongs to, e.g. '2026-11-07'.
  @Column({ type: 'date' })
  day: string;

  @Column({ type: 'int', default: 0 })
  count: number;
}
