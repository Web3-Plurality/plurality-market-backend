import { IsNull, LessThan } from 'typeorm';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';
import { PersonalAccessToken } from '../entity/personal-access-token';
import { AUTO_PAT_CLEANUP_AFTER_DAYS } from './limits';

// Shared between the token controller (re-mint) and the SIWE logout route.
const tokenRepository = AppDataSource.getRepository(PersonalAccessToken);

/** Revoke every still-active auto token of a user. Returns rows affected. */
export async function revokeAutoTokensForUser(userId: string): Promise<number> {
  const result = await tokenRepository.update({ userId, kind: 'auto', revokedAt: IsNull() }, { revokedAt: new Date() });
  return result.affected ?? 0;
}

/**
 * Delete auto tokens revoked long ago. Every page load mints a new auto
 * token and revokes the previous one, so without this the table would grow
 * by one row per visit. Best-effort: failures are logged, never surfaced.
 */
export async function cleanupRevokedAutoTokens(): Promise<void> {
  const cutoff = new Date(Date.now() - AUTO_PAT_CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000);
  try {
    await tokenRepository.delete({ kind: 'auto', revokedAt: LessThan(cutoff) });
  } catch (err) {
    Logger.warn(`[PAT] auto-token cleanup failed: ${(err as Error)?.message || err}`);
  }
}
