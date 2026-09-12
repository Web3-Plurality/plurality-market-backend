import { LessThan } from 'typeorm';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';
import { UserContext, ContextStatus } from '../entity/user-context';

// A context normally completes within a couple of minutes (chunk + embed).
// Past this cutoff the webhook is considered lost and the row is failed so
// the UI stops showing "Indexing" forever and the mint gate can clear.
const STALE_AFTER_MS = 15 * 60 * 1000;

const userContextRepository = AppDataSource.getRepository(UserContext);

/**
 * Fail contexts stuck "inprogress" past the cutoff. Called opportunistically
 * from list endpoints; the scope limits the sweep to rows the caller can see
 * anyway. Best-effort: an error here must never break the read path.
 */
export async function failStaleContexts(scope: { userId: string } | { profileId: string }): Promise<void> {
  try {
    await userContextRepository.update(
      {
        ...scope,
        status: ContextStatus.IN_PROGRESS,
        createdAt: LessThan(new Date(Date.now() - STALE_AFTER_MS)),
      },
      {
        status: ContextStatus.ERROR,
        errorMessage: 'Processing timed out after 15 minutes. Delete this item and add it again.',
      },
    );
  } catch (err) {
    Logger.warn(`[stale-contexts] sweep failed: ${(err as Error)?.message || err}`);
  }
}
