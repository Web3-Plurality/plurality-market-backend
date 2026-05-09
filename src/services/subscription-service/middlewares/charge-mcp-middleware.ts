import { Request, Response, NextFunction } from 'express';
import Logger from '../../../lib/logger';
import { deductCredits, getOrCreateUserSubscription } from '../utils';

/**
 * Charge a flat credit cost for MCP-driven calls (PAT or Hydra OAuth).
 *
 * Web-app users (internal JWT) are NOT charged — they're humans clicking
 * buttons in our own UI, not programmatic agents. The flat tier exists to
 * cover real-cost ops that don't already self-deduct (lists, reads, search,
 * bucket creation) and to put a credit-budget ceiling on agent traffic so
 * runaway loops can't DDoS us.
 *
 * Endpoints that already deduct on real token usage (save_memory,
 * save_conversation) should NOT use this — wrapping them would double-charge.
 *
 * Charges are deferred until the response finishes with a 2xx — failed or
 * rejected requests don't deduct.
 */
export const chargeMcpCall = (credits: number) => async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).send('Not authenticated');
  }

  // Skip charging for web-app traffic — only PAT and Hydra OAuth pay.
  const authMethod = req.user?.authMethod;
  const isMcpAuth = authMethod === 'pat' || authMethod === 'hydra';
  if (!isMcpAuth) return next();

  // Pre-check balance — short-circuit before any work happens so the agent
  // sees a clean 402 instead of a half-completed operation.
  //
  // We use the same `<= 0` rule as `checkSubscriptionAndCreditLimit` for
  // consistency: a user with any positive balance gets one overage call,
  // then the post-deduction clamp at zero blocks the next request. This
  // matches how the existing save-route deduction behaves and avoids two
  // different "out of credits" semantics across the codebase.
  try {
    const sub = await getOrCreateUserSubscription(userId);
    if (sub.creditsRemaining <= 0) {
      return res.status(402).json({
        error: 'No credits remaining. Please upgrade your subscription or wait for daily reset.',
        code: 'INSUFFICIENT_CREDITS',
        subscription: {
          planType: sub.planType,
          creditsRemaining: sub.creditsRemaining,
        },
      });
    }
  } catch (err) {
    Logger.error(`[chargeMcpCall] Pre-check failed for user ${userId}: ${(err as Error).message}`);
    // Fail open — don't block on a transient DB error.
    return next();
  }

  // Defer deduction to after the response so 4xx/5xx don't bill.
  // deductCredits divides tokensUsed by 100, so pass credits * 100 to charge
  // exactly `credits`.
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      deductCredits(userId, credits * 100).catch((err) => {
        Logger.error(`[chargeMcpCall] Post-charge failed for user ${userId}: ${err.message}`);
      });
    }
  });

  next();
};
