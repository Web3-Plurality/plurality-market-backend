import express, { Request, Response } from 'express';
import * as crypto from 'crypto';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { AppSumoLicense } from '../entity/appsumo-license';
import { AppSumoReviewPrompt, AppSumoReviewAction } from '../entity/appsumo-review-prompt';
import { UserSubscription } from '../entity/user-subscription';
import { PaymentTransaction } from '../entity/payment-transaction';
import { sendAppSumoReviewSlack } from '../utils/slack-feedback';
import { SubscriptionTransition, TransitionType, TransitionStatus } from '../entity/subscription-transition';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import jwt from 'jsonwebtoken';
import { COOKIE_NAME } from '../../auth-service/utils/cookie';
import { paymentService } from '../services/payment-service';
import { getOrCreateUserSubscription } from '../utils';
import { getSubscriptionPlan } from '../plans';
import Logger from '../../../lib/logger';
import { User } from '../../user-service/entity/user';
import { addMailchimpTag } from '../../auth-service/utils/mailchimp';
import * as dotenv from 'dotenv';

dotenv.config();

export const appSumoRouter = express.Router();

// --- Constants ---

const TIER_TO_PLAN_NAME: Record<number, string> = {
  1: 'APPSUMO_TIER_1',
  2: 'APPSUMO_TIER_2',
  3: 'APPSUMO_TIER_3',
};

const TIER_PRICES: Record<number, number> = {
  1: 59,
  2: 149,
  3: 339,
};

// --- Lazy repository getters ---

const getAppSumoLicenseRepository = () => AppDataSource.getRepository(AppSumoLicense);
const getUserSubscriptionRepository = () => AppDataSource.getRepository(UserSubscription);
const getAppSumoReviewPromptRepository = () => AppDataSource.getRepository(AppSumoReviewPrompt);

// --- Review prompt config ---
const REVIEW_PROMPT_BUFFER_DAYS = 2;
const REVIEW_PROMPT_SNOOZE_DAYS = 2;
const TERMINAL_REVIEW_ACTIONS: AppSumoReviewAction[] = ['POSITIVE', 'NEGATIVE', 'DISMISSED'];

/**
 * Compute whether to show the review prompt to a user with an active AppSumo license.
 * Returns true only when:
 *  - License has been active for >= REVIEW_PROMPT_BUFFER_DAYS
 *  - No terminal response (POSITIVE/NEGATIVE/DISMISSED) has been recorded
 *  - If latest response is NEEDS_MORE_TIME, the snooze window has elapsed
 */
async function shouldShowReviewPrompt(license: AppSumoLicense): Promise<boolean> {
  if (license.status !== 'ACTIVE' || !license.activatedAt || !license.userId) return false;

  const bufferMs = REVIEW_PROMPT_BUFFER_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(license.activatedAt).getTime() < bufferMs) return false;

  const latest = await getAppSumoReviewPromptRepository().findOne({
    where: { userId: license.userId },
    order: { respondedAt: 'DESC' },
  });

  if (!latest) return true;
  if (TERMINAL_REVIEW_ACTIONS.includes(latest.action)) return false;
  if (latest.action === 'NEEDS_MORE_TIME') {
    return latest.snoozeUntil ? Date.now() >= new Date(latest.snoozeUntil).getTime() : true;
  }
  return false;
}
// --- Helpers ---

/**
 * Verify the HMAC-SHA256 signature sent by AppSumo.
 * message = timestamp + rawBody (direct concatenation, no separator)
 * signature = HMAC-SHA256(message, APPSUMO_API_KEY).hexdigest()
 */
function verifyAppSumoSignature(rawBody: Buffer, timestamp: string, signature: string): boolean {
  const apiKey = process.env.APPSUMO_API_KEY;
  if (!apiKey) {
    Logger.error('APPSUMO_API_KEY not set');
    return false;
  }
  try {
    const message = `${timestamp}${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', apiKey).update(message).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

/**
 * Cancel the user's active Stripe subscription immediately (best-effort).
 */
async function cancelStripeSubscriptionIfPresent(subscription: UserSubscription): Promise<void> {
  if (!subscription.stripeSubscriptionId) {
    return;
  }
  try {
    await paymentService.stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
    Logger.info(`Cancelled Stripe subscription ${subscription.stripeSubscriptionId} for user ${subscription.userId}`);
    // Update DB immediately after Stripe cancel to keep state consistent
    await AppDataSource.transaction(async (transactionalEntityManager) => {
      await transactionalEntityManager.update(UserSubscription, subscription.id, {
        stripeSubscriptionId: null,
      });
    });
  } catch (err) {
    Logger.warn(`Failed to cancel Stripe subscription ${subscription.stripeSubscriptionId}: ${(err as Error).message}`);
  }
}

/**
 * Link an AppSumoLicense to a user and update UserSubscription + create PaymentTransaction.
 */
async function applyLicenseToUser(license: AppSumoLicense, userId: string): Promise<void> {
  const planName = TIER_TO_PLAN_NAME[license.tier];
  if (!planName) {
    throw new Error(`Unknown AppSumo tier: ${license.tier}`);
  }

  const plan = getSubscriptionPlan(planName);
  if (!plan) {
    throw new Error(`Subscription plan ${planName} not found`);
  }

  // Cancel any existing Stripe subscription (best-effort, outside transaction)
  const userSubscription = await getOrCreateUserSubscription(userId);
  await cancelStripeSubscriptionIfPresent(userSubscription);

  // Run remaining DB writes atomically
  await AppDataSource.transaction(async (manager) => {
    await manager.getRepository(UserSubscription).update(userSubscription.id, {
      planType: planName,
      creditsRemaining: plan.dailyCredits,
      creditsUsed: 0,
      expiresAt: null,
      lastResetAt: new Date(),
      stripeSubscriptionId: null,
    });

    const transaction = manager.getRepository(PaymentTransaction).create({
      userId,
      subscriptionId: userSubscription.id,
      planType: planName,
      amount: TIER_PRICES[license.tier] ?? 0,
      currency: 'USD',
      status: 'COMPLETED',
      invoiceId: license.licenseKey,
      metadata: {
        source: 'appsumo',
        licenseKey: license.licenseKey,
        tier: license.tier,
      },
    });
    await manager.getRepository(PaymentTransaction).save(transaction);

    await manager.getRepository(AppSumoLicense).update(license.id, {
      userId,
      status: 'ACTIVE',
      activatedAt: new Date(),
      deactivatedAt: null,
    });
  });

  Logger.info(`AppSumo license ${license.licenseKey} linked to user ${userId} with plan ${planName}`);
}

// ============================================================
// POST /webhook
// Receives AppSumo lifecycle events.  Raw body required for HMAC.
// Always returns 200 to prevent AppSumo retries.
// ============================================================
appSumoRouter.post('/webhook', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
  // #swagger.tags = ['AppSumo']
  let eventType = 'unknown';
  const startTime = Date.now();
  try {
    const rawBody: Buffer = req.body as Buffer;
    const timestamp = (req.headers['x-appsumo-timestamp'] as string) ?? '';
    const signature = (req.headers['x-appsumo-signature'] as string) ?? '';

    // Verify signature
    if (!verifyAppSumoSignature(rawBody, timestamp, signature)) {
      Logger.warn(`[APPSUMO WEBHOOK] Invalid signature (ip=${req.ip}, timestamp=${timestamp})`);
      return res.status(200).json({ success: false, warning: 'invalid_signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    eventType = payload.event ?? 'unknown';

    Logger.info(
      `[APPSUMO WEBHOOK] Received ${eventType} — license_key=${
        payload.license_key ?? payload.licenseKey ?? 'N/A'
      }, tier=${payload.tier ?? 'N/A'}, test=${payload.test ?? false}`,
    );

    // Always return 200 for test payloads
    if (payload.test === true) {
      return res.status(200).json({ success: true, event: eventType });
    }

    const licenseKey: string = payload.license_key ?? payload.licenseKey ?? '';
    const tier: number = Number(payload.tier ?? 1);

    if (!licenseKey && eventType !== 'migrate') {
      Logger.warn(`AppSumo webhook: missing license_key for event ${eventType}`);
      return res.status(200).json({ success: true, event: eventType, warning: 'missing_license_key' });
    }

    const licenseRepo = getAppSumoLicenseRepository();

    switch (eventType) {
      case 'purchase': {
        // Upsert license with status INACTIVE
        let license = await licenseRepo.findOne({ where: { licenseKey } });
        if (!license) {
          license = licenseRepo.create({
            licenseKey,
            tier,
            status: 'INACTIVE',
            userId: null,
            activatedAt: null,
            deactivatedAt: null,
          });
        } else {
          license.tier = tier;
          license.status = 'INACTIVE';
        }
        await licenseRepo.save(license);
        Logger.info(`[APPSUMO WEBHOOK] purchase: license ${licenseKey} saved (tier=${tier}, isNew=${!license.id})`);
        break;
      }

      case 'activate': {
        // Upsert license with status ACTIVE
        let license = await licenseRepo.findOne({ where: { licenseKey } });
        const isNew = !license;
        if (!license) {
          license = licenseRepo.create({
            licenseKey,
            tier,
            status: 'ACTIVE',
            userId: null,
            activatedAt: null,
            deactivatedAt: null,
          });
        } else {
          license.tier = tier;
          license.status = 'ACTIVE';
        }
        await licenseRepo.save(license);
        Logger.info(`[APPSUMO WEBHOOK] activate: license ${licenseKey} activated (tier=${tier}, isNew=${isNew})`);
        break;
      }

      case 'upgrade':
      case 'downgrade': {
        // AppSumo issues a brand-new license_key UUID on every upgrade/downgrade.
        // The old key arrives in prev_license_key — find by that, then swap the key.
        const prevLicenseKey: string = payload.prev_license_key ?? '';
        const license = prevLicenseKey ? await licenseRepo.findOne({ where: { licenseKey: prevLicenseKey } }) : null;
        if (!license) {
          Logger.warn(`AppSumo ${eventType}: prev_license_key ${prevLicenseKey} not found`);
          break;
        }
        const previousTier = license.tier;
        license.licenseKey = licenseKey; // replace old key with new UUID
        license.tier = tier;
        license.status = 'ACTIVE';
        await licenseRepo.save(license);

        // If license is linked to a user, update their subscription and record the change
        if (license.userId) {
          const newPlanName = TIER_TO_PLAN_NAME[tier];
          const prevPlanName = TIER_TO_PLAN_NAME[previousTier];
          const newPlan = newPlanName ? getSubscriptionPlan(newPlanName) : null;
          if (newPlan) {
            const userSub = await getUserSubscriptionRepository().findOne({
              where: { userId: license.userId },
            });
            if (userSub) {
              await AppDataSource.transaction(async (manager) => {
                await manager.getRepository(UserSubscription).update(userSub.id, {
                  planType: newPlanName,
                  creditsRemaining: newPlan.dailyCredits,
                  creditsUsed: 0,
                  expiresAt: null,
                  lastResetAt: new Date(),
                });

                const transaction = manager.getRepository(PaymentTransaction).create({
                  userId: license.userId!,
                  subscriptionId: userSub.id,
                  planType: newPlanName,
                  amount: TIER_PRICES[tier] ?? 0,
                  currency: 'USD',
                  status: 'COMPLETED',
                  invoiceId: licenseKey,
                  metadata: {
                    source: 'appsumo',
                    event: eventType,
                    prevLicenseKey,
                    licenseKey,
                    previousTier,
                    newTier: tier,
                  },
                });
                await manager.getRepository(PaymentTransaction).save(transaction);

                const transition = manager.getRepository(SubscriptionTransition).create({
                  userId: license.userId!,
                  subscriptionId: userSub.id,
                  fromPlanType: prevPlanName ?? `APPSUMO_TIER_${previousTier}`,
                  toPlanType: newPlanName,
                  transitionType: eventType === 'upgrade' ? TransitionType.UPGRADE : TransitionType.DOWNGRADE,
                  status: TransitionStatus.COMPLETED,
                  scheduledFor: null,
                  completedAt: new Date(),
                  stripeSubscriptionId: null,
                  invoiceId: licenseKey,
                  reason: payload.extra?.reason ?? null,
                  metadata: {
                    source: 'appsumo',
                    prevLicenseKey,
                    licenseKey,
                    previousTier,
                    newTier: tier,
                  },
                });
                await manager.getRepository(SubscriptionTransition).save(transition);
              });

              Logger.info(
                `AppSumo ${eventType}: user ${license.userId} moved from tier ${previousTier} to tier ${tier} (${newPlanName})`,
              );
            }
          }
        }
        break;
      }

      case 'deactivate': {
        const license = await licenseRepo.findOne({ where: { licenseKey } });
        if (!license) {
          Logger.warn(`AppSumo deactivate: license ${licenseKey} not found`);
          break;
        }

        // AppSumo sends a deactivate for the old key during upgrade/downgrade.
        // Only downgrade to FREE on actual refunds — not on tier changes.
        const deactivateReason: string = payload.extra?.reason ?? '';
        const isRefund =
          !deactivateReason.toLowerCase().includes('upgrad') && !deactivateReason.toLowerCase().includes('downgrad');

        license.status = 'DEACTIVATED';
        license.deactivatedAt = new Date();
        await licenseRepo.save(license);

        if (isRefund && license.userId) {
          const freePlan = getSubscriptionPlan('FREE');
          const userSub = await getUserSubscriptionRepository().findOne({
            where: { userId: license.userId },
          });
          if (userSub && freePlan) {
            await getUserSubscriptionRepository().update(userSub.id, {
              planType: 'FREE',
              creditsRemaining: freePlan.dailyCredits,
              expiresAt: null,
            });
            Logger.info(`AppSumo deactivate: user ${license.userId} downgraded to FREE (reason: ${deactivateReason})`);
          }
        } else if (!isRefund) {
          Logger.info(
            `AppSumo deactivate: skipping FREE downgrade for license ${licenseKey} (reason: ${deactivateReason})`,
          );
        }
        break;
      }

      case 'migrate':
      default: {
        Logger.info(`AppSumo webhook: unhandled event type "${eventType}" — no action taken`);
        break;
      }
    }

    Logger.info(`[APPSUMO WEBHOOK] ${eventType} processed successfully — took ${Date.now() - startTime}ms`);
    return res.status(200).json({ success: true, event: eventType });
  } catch (err) {
    Logger.error(`[APPSUMO WEBHOOK] Error processing ${eventType} after ${Date.now() - startTime}ms:`, err);
    // Still return 200 to prevent AppSumo retries
    return res.status(200).json({ success: true, event: eventType, warning: 'processed with errors' });
  }
});

// ============================================================
// GET /oauth/callback
// Exchanges OAuth code for license key and links to user.
// ============================================================
appSumoRouter.get('/oauth/callback', async (req: Request, res: Response) => {
  // #swagger.tags = ['AppSumo']
  const successUrl = process.env.APPSUMO_SUCCESS_URL ?? '/';
  const errorUrl = process.env.APPSUMO_ERROR_URL ?? '/';
  const loginUrl = process.env.APPSUMO_LOGIN_URL ?? '/login';

  // AppSumo validation ping: no code param → return 200 so the portal accepts the URL
  const code = req.query.code as string | undefined;
  if (!code) {
    return res.status(200).json({ ok: true });
  }

  try {
    // Step 1: Exchange code for access token immediately (code is single-use — do this
    // before any auth check so the code is never discarded unused)
    const tokenResponse = await axios.post(
      'https://appsumo.com/openid/token/',
      new URLSearchParams({
        client_id: process.env.APPSUMO_CLIENT_ID ?? '',
        client_secret: process.env.APPSUMO_CLIENT_SECRET ?? '',
        redirect_uri: process.env.APPSUMO_REDIRECT_URI ?? '',
        code,
        grant_type: 'authorization_code',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      },
    );

    const accessToken: string = tokenResponse.data.access_token;
    if (!accessToken) {
      Logger.error('AppSumo OAuth: no access_token in token response', tokenResponse.data);
      return res.redirect(`${errorUrl}?error=token_exchange_failed`);
    }

    // Step 2: Fetch license key (docs specify access_token as query param)
    const licenseResponse = await axios.get('https://appsumo.com/openid/license_key/', {
      params: { access_token: accessToken },
      timeout: 15000,
    });

    const licenseKey: string = licenseResponse.data.license_key;
    if (!licenseKey) {
      Logger.error('AppSumo OAuth: no license_key in license response', licenseResponse.data);
      return res.redirect(`${errorUrl}?error=license_fetch_failed`);
    }

    // Step 3: Find or create AppSumoLicense record so the key is persisted regardless
    // of whether the user is authenticated right now
    const licenseRepo = getAppSumoLicenseRepository();
    let license = await licenseRepo.findOne({ where: { licenseKey } });
    if (!license) {
      const tier: number = Number(licenseResponse.data.tier ?? 1);
      license = licenseRepo.create({
        licenseKey,
        tier,
        status: 'INACTIVE',
        userId: null,
        activatedAt: null,
        deactivatedAt: null,
      });
      await licenseRepo.save(license);
    }

    // Step 4: Try to identify the currently logged-in user from cookie or header.
    // If not authenticated, redirect to login with the license_key in the URL so the
    // frontend can call POST /appsumo/activate after the user logs in or signs up.
    const token =
      req.cookies?.[COOKIE_NAME] ?? (req.headers.authorization ? req.headers.authorization.split(' ')[1] : undefined);

    let userId: string | undefined;
    if (token) {
      try {
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET || '');
        userId = decoded?.id;
      } catch {
        // invalid/expired token — treat as unauthenticated
      }
    }

    if (!userId) {
      // User is not logged in. The license_key is now safely stored in the DB.
      // Send the user to login/signup; the frontend uses the license_key to activate
      // via POST /appsumo/activate once auth is complete.
      Logger.info(`AppSumo OAuth: license ${licenseKey} retrieved but user not authenticated — redirecting to login`);
      const separator = loginUrl.includes('?') ? '&' : '?';
      return res.redirect(`${loginUrl}${separator}appsumo_license_key=${encodeURIComponent(licenseKey)}`);
    }

    // Step 5: Already claimed by a different user
    if (license.userId && license.userId !== userId) {
      Logger.warn(`AppSumo OAuth: license ${licenseKey} already claimed by user ${license.userId}`);
      return res.redirect(`${errorUrl}?error=license_already_claimed`);
    }

    // Step 6: Already linked to this same user — idempotent success
    if (license.userId && license.userId === userId) {
      Logger.info(`AppSumo OAuth: license ${licenseKey} already active for user ${userId}`);
      const separator = successUrl.includes('?') ? '&' : '?';
      return res.redirect(`${successUrl}${separator}already_active=true`);
    }

    // Step 7: Link license to user
    await applyLicenseToUser(license, userId);

    // Tag user in Mailchimp (fire-and-forget, guarded against duplicates)
    const appSumoTag = process.env.MAILCHIMP_APPSUMO_TAG;
    if (appSumoTag) {
      const user = await AppDataSource.getRepository(User).findOne({ where: { id: userId } });
      if (user?.email) {
        addMailchimpTag(user.email, appSumoTag);
      }
    }

    return res.redirect(successUrl);
  } catch (err) {
    Logger.error('AppSumo OAuth callback error:', (err as any)?.response?.data ?? err);
    return res.redirect(`${errorUrl}?error=internal_error`);
  }
});

// ============================================================
// POST /activate
// Called by the frontend after login/signup when the user arrived
// via the AppSumo OAuth flow and was not yet authenticated.
// Body: { licenseKey: string }
// ============================================================
appSumoRouter.post('/activate', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AppSumo']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const licenseKey: string = req.body?.licenseKey;
    if (!licenseKey) {
      return res.status(400).json({ error: 'licenseKey is required' });
    }

    const licenseRepo = getAppSumoLicenseRepository();
    const license = await licenseRepo.findOne({ where: { licenseKey } });

    if (!license) {
      return res.status(404).json({ error: 'License not found' });
    }

    if (license.userId && license.userId !== userId) {
      return res.status(409).json({ error: 'License already claimed by another user' });
    }

    if (license.userId && license.userId === userId) {
      return res.status(200).json({ success: true, alreadyActive: true });
    }

    await applyLicenseToUser(license, userId);

    // Tag user in Mailchimp (fire-and-forget)
    const appSumoTag = process.env.MAILCHIMP_APPSUMO_TAG;
    if (appSumoTag) {
      const user = await AppDataSource.getRepository(User).findOne({ where: { id: userId } });
      if (user?.email) {
        addMailchimpTag(user.email, appSumoTag);
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    Logger.error('AppSumo activate error:', err);
    return res.status(500).json({ error: 'Failed to activate license' });
  }
});

// ============================================================
// GET /license-check
// Pre-checks a license key before showing the consent screen.
// Returns whether the license is claimable by the current user.
// ============================================================
appSumoRouter.get('/license-check', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AppSumo']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const licenseKey = req.query.licenseKey as string;
    if (!licenseKey) {
      return res.status(400).json({ error: 'licenseKey query param is required' });
    }

    const license = await getAppSumoLicenseRepository().findOne({ where: { licenseKey } });

    if (!license) {
      return res.status(200).json({ status: 'not_found' });
    }

    if (license.userId && license.userId === userId) {
      return res.status(200).json({ status: 'already_active_self' });
    }

    if (license.userId && license.userId !== userId) {
      return res.status(200).json({ status: 'claimed_by_other' });
    }

    return res.status(200).json({ status: 'available' });
  } catch (err) {
    Logger.error('AppSumo license-check error:', err);
    return res.status(500).json({ error: 'Failed to check license status' });
  }
});

// ============================================================
// GET /status
// Returns the AppSumo license status for the authenticated user.
// ============================================================
appSumoRouter.get('/status', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AppSumo']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    // Only consider ACTIVE licenses — users can have historical DEACTIVATED
    // rows from prior tier changes/cancellations. `hasAppSumoLicense` means
    // "currently entitled to AppSumo", not "ever had one".
    const license = await getAppSumoLicenseRepository().findOne({
      where: { userId, status: 'ACTIVE' },
      order: { activatedAt: 'DESC' },
    });

    if (!license) {
      return res.status(200).json({ hasAppSumoLicense: false });
    }

    const planName = TIER_TO_PLAN_NAME[license.tier] ?? null;
    const showReviewPrompt = await shouldShowReviewPrompt(license);

    return res.status(200).json({
      hasAppSumoLicense: true,
      tier: license.tier,
      status: license.status,
      activatedAt: license.activatedAt,
      planName,
      shouldShowReviewPrompt: showReviewPrompt,
    });
  } catch (err) {
    Logger.error('AppSumo status error:', err);
    return res.status(500).json({ error: 'Failed to fetch AppSumo license status' });
  }
});

// ============================================================
// POST /review-prompt
// Records a user's response to the AppSumo review prompt and
// fires a Slack notification for live ops visibility.
// Body: { action, rating?, feedback?, clickedReview? }
//   action: 'POSITIVE' | 'NEGATIVE' | 'NEEDS_MORE_TIME' | 'DISMISSED'
// ============================================================
appSumoRouter.post('/review-prompt', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AppSumo']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const { action, rating, feedback, clickedReview } = req.body ?? {};
    const validActions: AppSumoReviewAction[] = ['POSITIVE', 'NEGATIVE', 'NEEDS_MORE_TIME', 'DISMISSED'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (action === 'POSITIVE' || action === 'NEGATIVE') {
      if (typeof rating !== 'number' || rating < 1 || rating > 10) {
        return res.status(400).json({ error: 'rating (1-10) is required for POSITIVE/NEGATIVE actions' });
      }
      if (action === 'POSITIVE' && rating < 8) {
        return res.status(400).json({ error: 'POSITIVE action requires rating >= 8' });
      }
      if (action === 'NEGATIVE' && rating >= 8) {
        return res.status(400).json({ error: 'NEGATIVE action requires rating < 8' });
      }
    }

    const license = await getAppSumoLicenseRepository().findOne({ where: { userId } });
    if (!license) {
      return res.status(404).json({ error: 'No AppSumo license found for user' });
    }

    const now = new Date();
    const snoozeUntil =
      action === 'NEEDS_MORE_TIME' ? new Date(now.getTime() + REVIEW_PROMPT_SNOOZE_DAYS * 24 * 60 * 60 * 1000) : null;

    const promptRepo = getAppSumoReviewPromptRepository();
    const record = promptRepo.create({
      userId,
      licenseKey: license.licenseKey,
      action,
      rating: typeof rating === 'number' ? rating : null,
      feedback: typeof feedback === 'string' && feedback.trim() ? feedback.trim().slice(0, 2000) : null,
      clickedReview: Boolean(clickedReview),
      snoozeUntil,
      shownAt: now,
      respondedAt: now,
    });
    await promptRepo.save(record);

    // Fire-and-forget Slack notification
    const user = await AppDataSource.getRepository(User).findOne({ where: { id: userId } });
    sendAppSumoReviewSlack({
      action,
      rating: record.rating,
      feedback: record.feedback,
      clickedReview: record.clickedReview,
      userId,
      userEmail: user?.email ?? null,
      licenseKey: license.licenseKey,
      tier: license.tier,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    Logger.error('AppSumo review-prompt error:', err);
    return res.status(500).json({ error: 'Failed to record review prompt response' });
  }
});
