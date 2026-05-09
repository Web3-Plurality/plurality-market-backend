import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

export enum LoginType {
  stytch = 'STYTCH',
  google = 'GOOGLE',
  metamask = 'METAMASK',
}

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: true })
  name: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  authAddress: string;

  @Column({ nullable: true })
  pkpAddress: string;

  @Column({ nullable: false, default: false })
  subscribe: boolean;

  @Column({ nullable: false, default: '' })
  loginType: string;

  @Column({ nullable: true })
  chatEncKey: string;

  // User-selected default chat model key (e.g. "gemini-2.5-flash", "claude-sonnet-4").
  // Persisted across sessions and surfaces (memory studio + extension). Nullable
  // so the client can fall back to its product default when unset, and so we
  // can clear it without orphaning a deprecated/plan-restricted choice.
  @Column({ nullable: true })
  preferredModel: string;
}
