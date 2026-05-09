import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('ip_credit')
export class IpCredit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 45, unique: true })
  ipAddress: string;

  @Column({ type: 'integer', default: 100 })
  credits: number;

  @Column({ type: 'integer', default: 0 })
  tokensUsed: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
