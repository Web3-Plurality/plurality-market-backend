import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

export enum LoginType {
  metamask = 'METAMASK',
}

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: true })
  authAddress: string;

  @Column({ nullable: false, default: '' })
  loginType: string;
}
