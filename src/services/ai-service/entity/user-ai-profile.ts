import { Entity, Column, PrimaryColumn, CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';

// Interface for suggested prompt structure
export interface SuggestedPrompt {
  title: string;
  prompt: string;
  description: string;
}

@Entity('user_ai_profile')
export class UserAiProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column()
  profileName: string;

  @Column()
  image: string;

  @Column({ type: 'json', nullable: true })
  suggestedPrompts: SuggestedPrompt[];

  @Column({ type: 'boolean', default: false })
  published: boolean;

  @Column({ type: 'boolean', nullable: true, default: null })
  isPinned: boolean | null;

  @CreateDateColumn()
  createdAt: Date;
}
