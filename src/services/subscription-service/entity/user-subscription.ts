import { Entity, Column, PrimaryColumn, CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('user_subscription')
export class UserSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

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
    default: 'FREE',
  })
  planType: string;

  @Column({ type: 'integer', default: 0 })
  creditsRemaining: number;

  @Column({ type: 'integer', default: 0 })
  creditsUsed: number;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastResetAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeSubscriptionId: string | null; // Stripe subscription ID for recurring billing

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeCustomerId: string | null; // Stripe customer ID

  // @Column({
  //   type: 'enum',
  //   enum: ['active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'trialing'],
  //   nullable: true,
  // })
  // subscriptionStatus: string | null; // Stripe subscription status

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
