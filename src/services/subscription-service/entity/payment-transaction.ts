import { Entity, Column, PrimaryColumn, CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('payment_transaction')
export class PaymentTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  subscriptionId: string;

  @Column({
    type: 'enum',
    enum: [
      'PLUS_MONTHLY',
      'PLUS_YEARLY',
      'PRO_MONTHLY',
      'PRO_YEARLY',
      'APPSUMO_TIER_1',
      'APPSUMO_TIER_2',
      'APPSUMO_TIER_3',
    ],
  })
  planType: string; // Keep for backward compatibility

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED', 'CANCELED'] })
  status: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  invoiceId: string | null;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
