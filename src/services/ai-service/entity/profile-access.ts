import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';

export enum AccessRole {
  VIEWER = 'viewer',
  EDITOR = 'editor',
}

@Entity('profile_access')
@Unique(['profileId', 'grantedToId'])
export class ProfileAccess {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  profileId: string;

  @Column({ type: 'uuid' })
  ownerId: string;

  @Column({ type: 'uuid' })
  grantedToId: string;

  @Column({ type: 'varchar', default: AccessRole.VIEWER })
  role: AccessRole;

  @Column({ type: 'boolean', nullable: true, default: null })
  isPinned: boolean | null;

  @Column({ type: 'uuid' })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
