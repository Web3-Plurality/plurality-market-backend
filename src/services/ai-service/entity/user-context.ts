import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

// Enum for context status
export enum ContextStatus {
  COMPLETED = 'completed',
  IN_PROGRESS = 'inprogress',
  ERROR = 'error',
}

@Entity('user_context')
export class UserContext {
  @PrimaryColumn()
  contextId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  profileId: string;

  @Column({ type: 'text', nullable: true })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({
    type: 'enum',
    enum: ContextStatus,
    nullable: true,
  })
  status: ContextStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'jsonb', nullable: true })
  vectorIds: string[];

  @CreateDateColumn({ nullable: true })
  createdAt: Date;

  // Metadata fields for source identification
  @Column({ type: 'text', nullable: true })
  originalFileName: string; // Original filename before AI processing (for file uploads)

  @Column({ type: 'text', nullable: true })
  sourceType: string; // 'file' | 'chat' | 'text' - indicates how context was added

  @Column({ type: 'text', nullable: true })
  sourcePlatform: string; // For chat contexts: 'chatgpt' | 'claude' | 'gemini' | etc.

  @Column({ type: 'bigint', nullable: true })
  contentSize: number; // Size in bytes for all content types (files, text, chat)

  // On-chain provenance fields
  @Column({ type: 'varchar', nullable: true })
  contentHash: string | null; // SHA-256 hash of original content

  @Column({ type: 'boolean', default: false })
  registeredOnChain: boolean; // Whether registered in ContextRegistry

  @Column({ type: 'varchar', nullable: true })
  registryTxHash: string | null; // Registration transaction hash
}
