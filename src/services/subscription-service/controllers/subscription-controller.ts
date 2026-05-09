import express, { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../../../data-source';
import { UserSubscription } from '../entity/user-subscription';
import { PaymentTransaction } from '../entity/payment-transaction';
import { SubscriptionTransition, TransitionType, TransitionStatus } from '../entity/subscription-transition';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { paymentService } from '../services/payment-service';
import Logger from '../../../lib/logger';
import * as dotenv from 'dotenv';
import {
  getOrCreateUserSubscription,
  isSubscriptionValid,
  shouldResetCredits,
  getSubscriptionPlans,
  getSubscriptionPlan,
  getAppSumoPlans,
  analyzePlanChange,
  PlanChangeDirection,
  getSubscriptionDetails,
  getContextSizeLimits,
  formatBytes,
} from '../utils';
import { User } from '../../user-service/entity/user';
import { PlanConfig } from '../plans';

dotenv.config();

export const subscriptionRouter = express.Router();

// Repository instances
const userSubscriptionRepository = AppDataSource.getRepository(UserSubscription);
const paymentTransactionRepository = AppDataSource.getRepository(PaymentTransaction);
const userRepository = AppDataSource.getRepository(User);
const subscriptionTransitionRepository = AppDataSource.getRepository(SubscriptionTransition);

// Get user's current subscription status
subscriptionRouter.get('/status', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    const subscriptionDetails = await getSubscriptionDetails(userId);
    const contextStorage = await getContextSizeLimits(userId);
    const freePlan = await getSubscriptionPlan('FREE');

    // Check if there's already a pending or in-progress transition for this subscription
    let isScheduled = false;
    let scheduledDate = null;
    let toPlanConfig: ReturnType<typeof getSubscriptionPlan> = null;
    let fromPlanConfig: ReturnType<typeof getSubscriptionPlan> = null;
    const pendingTransition = await paymentService.hasPendingTransition(subscriptionDetails.id);
    if (pendingTransition) {
      toPlanConfig = getSubscriptionPlan(pendingTransition.toPlanType);
      fromPlanConfig = getSubscriptionPlan(pendingTransition.fromPlanType);
      isScheduled = pendingTransition.status === TransitionStatus.PENDING;
      scheduledDate =
        isScheduled && pendingTransition.scheduledFor
          ? new Date(pendingTransition.scheduledFor).toLocaleDateString()
          : null;

      if (pendingTransition.toPlanType === freePlan?.name && subscriptionDetails.planType === freePlan?.name) {
        pendingTransition.status = TransitionStatus.COMPLETED;
        pendingTransition.completedAt = new Date();
        await subscriptionTransitionRepository.save(pendingTransition);
        return res.status(200).json({
          subscription: subscriptionDetails,
          pendingTransition: null,
        });
      }
    }
    res.status(200).json({
      subscription: subscriptionDetails,
      contextStorage,
      pendingTransition: pendingTransition
        ? {
            id: pendingTransition.id,
            fromPlan: pendingTransition.fromPlanType,
            fromPlanDisplayName: fromPlanConfig?.displayName || pendingTransition.fromPlanType,
            toPlan: pendingTransition.toPlanType,
            toPlanDisplayName: toPlanConfig?.displayName || pendingTransition.toPlanType,
            type: pendingTransition.transitionType,
            status: pendingTransition.status,
            scheduledFor: pendingTransition.scheduledFor,
            createdAt: pendingTransition.createdAt,
            isScheduled: isScheduled,
          }
        : null,
    });
  } catch (error) {
    Logger.error('Error fetching subscription status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Preview plan change (check what will happen before committing)
subscriptionRouter.post('/preview-change', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;
    const { targetPlanType } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    if (
      !targetPlanType ||
      !['PLUS_MONTHLY', 'PLUS_YEARLY', 'PRO_MONTHLY', 'PRO_YEARLY', 'FREE'].includes(targetPlanType)
    ) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    const subscription = await getOrCreateUserSubscription(userId);
    const currentPlan = await getSubscriptionPlan(subscription.planType);
    const targetPlan = await getSubscriptionPlan(targetPlanType);

    if (!targetPlan) {
      return res.status(400).json({ error: `Target plan ${targetPlanType} not found` });
    }

    // Analyze the plan change
    const analysis = analyzePlanChange(subscription.planType, targetPlanType);

    res.status(200).json({
      currentPlan: {
        name: currentPlan?.name,
        displayName: currentPlan?.displayName,
        displayNameShort: currentPlan?.displayNameShort,
        price: currentPlan?.price,
        currency: currentPlan?.currency,
      },
      targetPlan: {
        name: targetPlan.name,
        displayName: targetPlan.displayName,
        displayNameShort: targetPlan.displayNameShort,
        price: targetPlan.price,
        currency: targetPlan.currency,
      },
      changeAnalysis: {
        direction: analysis.direction,
        willChargeImmediately: analysis.shouldProrateImmediately,
        willScheduleForLater: analysis.shouldScheduleForLater,
        rationale: analysis.rationale,
        effectiveDate: analysis.shouldScheduleForLater
          ? new Date(new Date(subscription.expiresAt!).getTime() - 3 * 24 * 60 * 60 * 1000)
          : new Date(),
      },
    });
  } catch (error) {
    Logger.error('Error previewing plan change:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Initiate subscription upgrade (new users from FREE plan)
subscriptionRouter.post('/upgrade', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;
    const { planType, customerEmail } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    // Validate plan type
    if (!planType || !['PLUS_MONTHLY', 'PLUS_YEARLY', 'PRO_MONTHLY', 'PRO_YEARLY'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type. Must be MONTHLY or YEARLY' });
    }

    const subscription = await getOrCreateUserSubscription(userId);

    // Check if user subscribe first time or moving from free to  paid plan
    if (subscription.planType === 'FREE') {
      const selectedPlan = await getSubscriptionPlan(planType);

      if (!selectedPlan) {
        return res.status(400).json({ error: `Subscription plan ${planType} not found` });
      }

      Logger.info(`Creating Stripe checkout session for user ${userId} with subscription ID ${subscription.id}`);
      // Here we would integrate with our payment gateway (Stripe, PayPal, etc.)
      // Create Stripe checkout session
      const { sessionId, sessionUrl } = await paymentService.createCheckoutSession(
        userId,
        subscription.id,
        planType as string,
        customerEmail,
      );

      res.status(200).json({
        message: 'Upgrade initiated successfully',
        selectedPlan: {
          name: selectedPlan.name,
          displayName: selectedPlan.displayName,
          displayNameShort: selectedPlan.displayNameShort,
          price: selectedPlan.price,
          currency: selectedPlan.currency,
          features: selectedPlan.features,
        },
        checkoutSession: {
          id: sessionId,
          url: sessionUrl,
        },
      });
    } else {
      // user has active paid plane, and needs to upgrade and downgrade
      const targetPlanType = planType;
      // Check if subscription is valid
      if (!isSubscriptionValid(subscription)) {
        return res.status(400).json({
          error: 'Your subscription has expired. Please renew or upgrade using the /upgrade endpoint.',
        });
      }

      // Analyze the plan change
      const analysis = analyzePlanChange(subscription.planType, targetPlanType);

      // Check if it's the same plan
      if (analysis.direction === PlanChangeDirection.SAME) {
        return res.status(400).json({
          error: 'You are already on this plan',
          currentPlan: subscription.planType,
        });
      }

      const targetPlan = await getSubscriptionPlan(targetPlanType);
      if (!targetPlan) {
        return res.status(400).json({ error: `Target plan ${targetPlanType} not found` });
      }

      // Check if there's already a pending or in-progress transition for this subscription
      const pendingTransition = await paymentService.hasPendingTransition(subscription.id);
      if (pendingTransition) {
        // If the pending transition is a scheduled cancellation to FREE, revert it and proceed
        if (
          pendingTransition.toPlanType === 'FREE' &&
          pendingTransition.status === TransitionStatus.PENDING &&
          subscription.stripeSubscriptionId
        ) {
          Logger.info(
            `Reverting pending cancellation (transition ${pendingTransition.id}) for user ${userId} to allow plan change to ${targetPlanType}`,
          );
          await AppDataSource.transaction(async (transactionalEntityManager) => {
            // Remove cancel_at_period_end on Stripe
            await paymentService.stripe.subscriptions.update(subscription.stripeSubscriptionId!, {
              cancel_at_period_end: false,
            });
            // Mark the FREE transition as cancelled
            pendingTransition.status = TransitionStatus.CANCELLED;
            pendingTransition.completedAt = new Date();
            pendingTransition.metadata = {
              ...((pendingTransition.metadata as Record<string, unknown>) || {}),
              cancelledReason: `Replaced by plan change to ${targetPlanType}`,
            };
            await transactionalEntityManager.save(SubscriptionTransition, pendingTransition);
          });
          Logger.info(`Reverted pending cancellation for user ${userId}, proceeding with plan change`);
        } else {
          // Block: non-FREE pending transition
          const scheduledPlan = getSubscriptionPlan(pendingTransition.toPlanType);
          const isScheduled = pendingTransition.status === TransitionStatus.PENDING;
          const scheduledDate =
            isScheduled && pendingTransition.scheduledFor
              ? new Date(pendingTransition.scheduledFor).toLocaleDateString()
              : null;

          const message = isScheduled
            ? `You have a pending ${pendingTransition.transitionType.toLowerCase()} scheduled to ${
                scheduledPlan?.displayName || pendingTransition.toPlanType
              } ${
                scheduledDate ? `on ${scheduledDate}` : 'at the end of current billing period'
              }. Please wait for it to complete before making another change.`
            : `A ${pendingTransition.transitionType.toLowerCase()} to ${
                scheduledPlan?.displayName || pendingTransition.toPlanType
              } is currently in progress. Please wait for it to complete before making another change.`;

          return res.status(409).json({
            error: 'A subscription change is already in progress or scheduled',
            message,
            pendingTransition: {
              id: pendingTransition.id,
              fromPlan: pendingTransition.fromPlanType,
              toPlan: pendingTransition.toPlanType,
              type: pendingTransition.transitionType,
              status: pendingTransition.status,
              scheduledFor: pendingTransition.scheduledFor,
              createdAt: pendingTransition.createdAt,
            },
          });
        }
      }

      // Handle upgrade vs downgrade
      if (analysis.shouldProrateImmediately) {
        // UPGRADE: Immediate billing with proration
        const result = await paymentService.updateSubscriptionImmediately(subscription.id, targetPlanType, {
          direction: analysis.direction,
          rationale: analysis.rationale,
        });

        Logger.info(
          `User ${userId} upgraded from ${subscription.planType} to ${targetPlanType} with immediate proration`,
        );

        res.status(200).json({
          success: true,
          message: result.message,
          changeType: 'UPGRADE',
          newPlan: {
            name: targetPlan.name,
            displayName: targetPlan.displayName,
            displayNameShort: targetPlan.displayNameShort,
            price: targetPlan.price,
            currency: targetPlan.currency,
            features: targetPlan.features,
          },
          billingDetails: {
            chargedImmediately: true,
            prorationApplied: true,
            effectiveDate: new Date(),
          },
        });
      } else if (analysis.shouldScheduleForLater) {
        // DOWNGRADE: Schedule for end of billing period, no proration
        const result = await paymentService.scheduleSubscriptionChange(subscription.id, targetPlanType, {
          direction: analysis.direction,
          rationale: analysis.rationale,
        });

        Logger.info(
          `User ${userId} scheduled downgrade from ${subscription.planType} to ${targetPlanType} at period end`,
        );

        res.status(200).json({
          success: true,
          message: result.message,
          changeType: 'DOWNGRADE',
          newPlan: {
            name: targetPlan.name,
            displayName: targetPlan.displayName,
            displayNameShort: targetPlan.displayNameShort,
            price: targetPlan.price,
            currency: targetPlan.currency,
            features: targetPlan.features,
          },
          billingDetails: {
            chargedImmediately: false,
            prorationApplied: false,
            effectiveDate: result.effectiveDate,
            currentPlanExpiresAt: subscription.expiresAt,
          },
        });
      }
    }
  } catch (error) {
    Logger.error('Error initiating subscription upgrade:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/subscription/verify-payment - Verify checkout session payment status
subscriptionRouter.get('/verify-payment', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const { session_id } = req.query; // eslint-disable-line

    if (!session_id || typeof session_id !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid session_id parameter',
        subscription: null,
      });
    }

    Logger.info(`Verifying payment for checkout session: ${session_id}`);

    // Retrieve the session from Stripe
    const session = await paymentService.stripe.checkout.sessions.retrieve(session_id);

    // Check payment status
    const isPaid = session.payment_status === 'paid';

    if (!isPaid) {
      Logger.warn(`Payment not completed for session ${session_id}. Status: ${session.payment_status}`);
      return res.status(200).json({
        success: false,
        paymentStatus: session.payment_status,
        message: 'Payment has not been completed yet',
        subscription: null,
      });
    }

    const verifiedPlan = session.metadata?.planType ? getSubscriptionPlan(session.metadata.planType) : null;
    return res.status(200).json({
      success: true,
      paymentStatus: 'paid',
      message: 'Payment completed successfully',
      subscription: {
        planType: session.metadata?.planType,
        displayName: verifiedPlan?.displayName || session.metadata?.planType,
        displayNameShort: verifiedPlan?.displayNameShort || session.metadata?.planType,
      },
    });
  } catch (error: any) {
    Logger.error('Error verifying payment:', error);
    // Handle Stripe errors gracefully
    if (error.type === 'StripeInvalidRequestError') {
      return res.status(404).json({
        success: false,
        error: 'Invalid session ID or session not found',
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to verify payment status',
    });
  }
});

// POST /api/subscription/webhook - Handle Stripe webhook events
// Strategy: verify signature, process synchronously, respond with result.
// Stripe allows up to 20s and retries on failure — so we process first and let
// Stripe retry if anything goes wrong, rather than fire-and-forget with a premature 200.
subscriptionRouter.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  try {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      return res.status(400).json({ error: 'Missing Stripe signature' });
    }

    // Ensure we have the raw body as Buffer or string
    const payload: string | Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

    // Verify signature — reject invalid payloads before processing
    const event = paymentService.verifyWebhookSignature(payload, signature);
    Logger.info(`[STRIPE WEBHOOK] Received ${event.type} (event=${event.id}, apiVersion=${event.api_version})`);

    // Process the event synchronously — if it fails, Stripe will retry (up to ~16 times over 3 days)
    await paymentService.processWebhookEvent(event);

    res.status(200).json({ received: true });
  } catch (error) {
    Logger.error(`[STRIPE WEBHOOK] Failed to process webhook (ip=${req.ip}): ${error}`);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

//  Get payment history
subscriptionRouter.get('/payment-history', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    const transactions = await paymentTransactionRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    // Fetch invoice URLs from Stripe for transactions that have invoiceId
    const transactionsWithInvoices = await Promise.all(
      transactions.map(async (transaction) => {
        let invoiceUrl = null;

        // If transaction has a Stripe invoiceId (starts with 'in_'), fetch the invoice URL
        if (transaction.invoiceId && transaction.invoiceId.startsWith('in_')) {
          try {
            const invoice = await paymentService.stripe.invoices.retrieve(transaction.invoiceId);
            // Use hosted_invoice_url for web viewing or invoice_pdf for direct PDF download
            invoiceUrl = invoice.hosted_invoice_url || invoice.invoice_pdf || null;
          } catch (error) {
            Logger.error(`Error fetching invoice ${transaction.invoiceId} from Stripe:`, error);
            // Continue without invoice URL if Stripe fetch fails
          }
        }

        const plan = getSubscriptionPlan(transaction.planType);
        return {
          id: transaction.id,
          planType: transaction.planType,
          displayName: plan?.displayName || transaction.planType,
          displayNameShort: plan?.displayNameShort || transaction.planType,
          amount: transaction.amount,
          currency: transaction.currency,
          status: transaction.status,
          invoiceId: transaction.invoiceId,
          invoiceUrl: invoiceUrl,
          createdAt: transaction.createdAt,
          metadata: transaction.metadata,
        };
      }),
    );

    res.status(200).json({
      transactions: transactionsWithInvoices,
    });
  } catch (error) {
    Logger.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Cancel subscription
subscriptionRouter.post('/cancel', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    const subscription = await getOrCreateUserSubscription(userId);

    // Check if user has an active Stripe subscription
    if (!subscription.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No active recurring subscription found' });
    }

    // Check if there's already a pending or in-progress transition for this subscription
    const pendingTransition = await paymentService.hasPendingTransition(subscription.id);
    if (pendingTransition) {
      // If already scheduled to cancel to FREE, return a clear message
      if (pendingTransition.toPlanType === 'FREE') {
        const scheduledDate = pendingTransition.scheduledFor
          ? new Date(pendingTransition.scheduledFor).toLocaleDateString()
          : null;
        return res.status(409).json({
          error: 'Cancellation already scheduled',
          message: `Your subscription is already scheduled to be cancelled${
            scheduledDate ? ` on ${scheduledDate}` : ' at the end of your current billing period'
          }.`,
        });
      }

      const scheduledPlan = getSubscriptionPlan(pendingTransition.toPlanType);
      const isScheduled = pendingTransition.status === TransitionStatus.PENDING;
      const scheduledDate =
        isScheduled && pendingTransition.scheduledFor
          ? new Date(pendingTransition.scheduledFor).toLocaleDateString()
          : null;

      const message = isScheduled
        ? `You have a pending ${pendingTransition.transitionType.toLowerCase()} scheduled to ${
            scheduledPlan?.displayName || pendingTransition.toPlanType
          } ${
            scheduledDate ? `on ${scheduledDate}` : 'at the end of current billing period'
          }. Please wait for it to complete before making another change.`
        : `A ${pendingTransition.transitionType.toLowerCase()} to ${
            scheduledPlan?.displayName || pendingTransition.toPlanType
          } is currently in progress. Please wait for it to complete before making another change.`;

      return res.status(409).json({
        error: 'A subscription change is already in progress or scheduled',
        message,
      });
    }

    await AppDataSource.transaction(async (transactionalEntityManager) => {
      // Get current Stripe subscription to find the period end
      const stripeSubscription = await paymentService.stripe.subscriptions.retrieve(subscription.stripeSubscriptionId!);

      // Schedule the subscription change at period end
      const currentItem = stripeSubscription.items.data[0];
      const periodEnd = new Date((currentItem as any).current_period_end * 1000);

      const newPlan = getSubscriptionPlan('FREE');

      // Create transition record within transaction
      const transition = transactionalEntityManager.create(SubscriptionTransition, {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        fromPlanType: subscription.planType,
        toPlanType: newPlan?.name || 'FREE',
        transitionType: TransitionType.DOWNGRADE,
        status: TransitionStatus.PENDING,
        scheduledFor: periodEnd,
        stripeSubscriptionId: subscription.stripeSubscriptionId!,
        metadata: {
          changeType: 'scheduled_cancellation',
        },
      });

      await transactionalEntityManager.save(SubscriptionTransition, transition);

      if (!subscription.stripeSubscriptionId) {
        throw new Error('No active Stripe subscription found');
      }
      // Cancel the Stripe subscription
      await paymentService.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

      Logger.info(`Scheduled cancellation for subscription ${subscription.stripeSubscriptionId} for user ${userId}`);
    });

    res.status(200).json({
      message: 'Subscription will be canceled at the end of the current billing period',
      subscription: {
        id: subscription.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        expiresAt: subscription.expiresAt,
      },
    });
  } catch (error) {
    Logger.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get available subscription plans
subscriptionRouter.get('/plans', async (req: Request, res: Response) => {
  // #swagger.tags = ['Subscription']
  try {
    const plansObject = getSubscriptionPlans();

    const serializePlan = (plan: PlanConfig) => ({
      name: plan.name,
      displayName: plan.displayName,
      displayNameShort: plan.displayNameShort,
      description: plan.description,
      price: plan.price,
      currency: plan.currency,
      credits: plan.dailyCredits,
      features: plan.features,
      durationInMonths: plan.durationInMonths,
      maxContextSizeBytes: plan.maxContextSizeBytes,
      maxContextSizeFormatted: formatBytes(plan.maxContextSizeBytes),
    });

    const plans = Object.values(plansObject || {})
      .filter((plan) => plan.isActive)
      .map(serializePlan);

    const appSumoPlans = getAppSumoPlans().map(serializePlan);

    res.status(200).json({
      plans,
      appSumoPlans,
    });
  } catch (error) {
    Logger.error('Error fetching subscription plans:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
