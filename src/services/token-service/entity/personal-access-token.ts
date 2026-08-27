import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

@Entity('personal_access_token')
@Index(['userId'])
@Index(['authAddress'])
@Index(['tokenHash'], { unique: true })
export class PersonalAccessToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  // Denormalized wallet address of the PAT owner. Stamped at create time from
  // the SIWE-authenticated session. PAT verify returns this directly so MCP /
  // backend callers can resolve wallet identity without joining the users
  // table on the hot path.
  // Nullable in the schema for safety during the rewrite — wipe-and-redeploy
  // (Phase 12) starts everyone fresh with a non-null value.
  @Column({ type: 'varchar', length: 42, nullable: true })
  authAddress: string | null;

  @Column({ type: 'varchar', length: 255 })
  tokenHash: string;

  @Column({ type: 'varchar', length: 16 })
  tokenPrefix: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column('text', { array: true, default: ['mcp:tools'] })
  scopes: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  lastUsedIp: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  createdIp: string | null;
}
