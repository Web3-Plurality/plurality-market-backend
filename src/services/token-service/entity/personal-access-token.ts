import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

@Entity('personal_access_token')
@Index(['userId'])
@Index(['tokenHash'], { unique: true })
export class PersonalAccessToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

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

  @Column({ type: 'uuid', nullable: true })
  rotatedToId: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  createdIp: string | null;
}
