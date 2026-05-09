import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type AppSumoReviewAction = 'POSITIVE' | 'NEGATIVE' | 'NEEDS_MORE_TIME' | 'DISMISSED';

@Entity('appsumo_review_prompt')
export class AppSumoReviewPrompt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  licenseKey: string | null;

  @Column({ type: 'enum', enum: ['POSITIVE', 'NEGATIVE', 'NEEDS_MORE_TIME', 'DISMISSED'] })
  action: AppSumoReviewAction;

  @Column({ type: 'integer', nullable: true })
  rating: number | null;

  @Column({ type: 'text', nullable: true })
  feedback: string | null;

  @Column({ type: 'boolean', default: false })
  clickedReview: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  snoozeUntil: Date | null;

  @Column({ type: 'timestamptz' })
  shownAt: Date;

  @Column({ type: 'timestamptz' })
  respondedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
