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

  @Column({ type: 'text', nullable: true })
  sourceUrl: string; // URL of the page the content was captured from (extension save-page / save-text / save-chat)

  @Column({ type: 'bigint', nullable: true })
  contentSize: number; // Size in bytes for all content types (files, text, chat)

  @Column({ type: 'uuid', nullable: true })
  addedBy: string; // Tracks who actually added this context (for shared bucket editor-own-only enforcement)
}
