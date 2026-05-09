import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('appsumo_license')
export class AppSumoLicense {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  licenseKey: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'integer' })
  tier: number;

  @Column({ type: 'enum', enum: ['INACTIVE', 'ACTIVE', 'DEACTIVATED'], default: 'INACTIVE' })
  status: 'INACTIVE' | 'ACTIVE' | 'DEACTIVATED';

  @Column({ type: 'varchar', length: 255, nullable: true })
  invoiceItemUuid: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deactivatedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
