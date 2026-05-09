import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum TransitionStatus {
  PENDING = 'PENDING', // Scheduled for future (downgrades)
  IN_PROGRESS = 'IN_PROGRESS', // Immediate change initiated (upgrades)
  COMPLETED = 'COMPLETED', // Transition completed successfully
  CANCELLED = 'CANCELLED', // Transition cancelled/replaced by another change
  FAILED = 'FAILED', // Transition failed
}

export enum TransitionType {
  UPGRADE = 'UPGRADE',
  DOWNGRADE = 'DOWNGRADE',
}

@Entity('subscription_transition')
export class SubscriptionTransition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  subscriptionId: string;

  @Column({
    type: 'enum',
    enum: [
      'FREE',
      'PLUS_MONTHLY',
      'PLUS_YEARLY',
      'PRO_MONTHLY',
      'PRO_YEARLY',
      'APPSUMO_TIER_1',
      'APPSUMO_TIER_2',
      'APPSUMO_TIER_3',
    ],
  })
  fromPlanType: string;

  @Column({
    type: 'enum',
    enum: [
      'FREE',
      'PLUS_MONTHLY',
      'PLUS_YEARLY',
      'PRO_MONTHLY',
      'PRO_YEARLY',
      'APPSUMO_TIER_1',
      'APPSUMO_TIER_2',
      'APPSUMO_TIER_3',
    ],
  })
  toPlanType: string;

  @Column({ type: 'enum', enum: TransitionType })
  transitionType: TransitionType;

  @Column({ type: 'enum', enum: TransitionStatus, default: TransitionStatus.PENDING })
  status: TransitionStatus;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledFor: Date | null; // When the transition should take effect (for downgrades)

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null; // When the transition was actually completed

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeSubscriptionId: string | null; // Stripe subscription ID

  @Column({ type: 'varchar', length: 255, nullable: true })
  invoiceId: string | null; // Stripe invoice ID (for immediate upgrades)

  @Column({ type: 'text', nullable: true })
  reason: string | null; // Reason for cancellation/replacement

  @Column({ type: 'json', nullable: true })
  metadata: any; // Additional data (e.g., analysis results, Stripe metadata)

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
