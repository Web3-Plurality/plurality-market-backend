import Stripe from 'stripe';
import { AppDataSource } from '../../../data-source';
import { PaymentTransaction } from '../entity/payment-transaction';
import { UserSubscription } from '../entity/user-subscription';
import { SubscriptionTransition, TransitionStatus, TransitionType } from '../entity/subscription-transition';
import Logger from '../../../lib/logger';
import * as dotenv from 'dotenv';
import { getSubscriptionPlan, getSubscriptionPlanByStripePriceId, PlanConfig } from '../plans';

dotenv.config();

/* eslint-disable */
export class PaymentService {
  public stripe: Stripe; // Make it public so it can be accessed from controller
  private paymentTransactionRepository = AppDataSource.getRepository(PaymentTransaction);
  private userSubscriptionRepository = AppDataSource.getRepository(UserSubscription);
  private subscriptionTransitionRepository = AppDataSource.getRepository(SubscriptionTransition);

  // Utility method to safely create Date from timestamp
  private createDateFromTimestamp(endPeriodOfSubscription: number, fallbackPlanType?: string, context?: string): Date {
    if (endPeriodOfSubscription) {
      Logger.info(`Setting date to ${new Date(endPeriodOfSubscription * 1000)} for ${context}`);
      const expireDate = new Date(endPeriodOfSubscription * 1000);
      expireDate.setDate(expireDate.getDate() + 3);
      return expireDate;
    }

    // Fallback: set expiry based on plan type
    const fallbackDate = new Date();
    if (fallbackPlanType?.includes('PLUS_YEARLY') || fallbackPlanType?.includes('PRO_YEARLY')) {
      fallbackDate.setFullYear(fallbackDate.getFullYear() + 1);
      Logger.info(`Setting fallback date to ${fallbackDate} for PLUS_YEARLY or PRO_YEARLY`);
    } else if (fallbackPlanType?.includes('PLUS_MONTHLY') || fallbackPlanType?.includes('PRO_MONTHLY')) {
      fallbackDate.setMonth(fallbackDate.getMonth() + 1);
    } else {
      Logger.warn(`Invalid plan type in ${context || 'unknown context'}: ${fallbackPlanType}`);
      // Default fallback: 30 days from now
      fallbackDate.setMonth(fallbackDate.getMonth() + 1);
    }
    // adding buffer of 3 days
    fallbackDate.setDate(fallbackDate.getDate() + 3);
    return fallbackDate;
  }

  constructor() {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }

    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  // Create Stripe checkout session (alternative to payment intent)
  async createCheckoutSession(
    userId: string,
    subscriptionId: string,
    planType: string,
    customerEmail?: string,
  ): Promise<{ sessionId: string; sessionUrl: string }> {
    try {
      const planConfig = getSubscriptionPlan(planType);

      if (!planConfig) {
        throw new Error(`Subscription plan ${planType} not found`);
      }

      if (!planConfig.stripePriceId) {
        throw new Error(`Stripe price ID not configured for plan ${planType}`);
      }

      // Create checkout session
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer_email: customerEmail || undefined,
        line_items: [
          {
            // need priceId for recurring
            price: planConfig.stripePriceId!,
            // no need for price_data for recurring
            // price_data: {
            //   currency: planConfig.currency.toLowerCase(),
            //   product_data: {
            //     name: `Plurality AI - ${planType} Subscription`,
            //     description:
            //       planType === 'MONTHLY'
            //         ? 'Monthly unlimited access to Plurality AI'
            //         : 'Yearly unlimited access to Plurality AI (16% discount)',
            //   },
            //   unit_amount: Math.round(planConfig.price * 100), // Convert to cents
            // },
            quantity: 1,
          },
        ],
        mode: 'subscription',
        allow_promotion_codes: true,
        // success_url cannot reference session.id before session is created.
        // Use Stripe's placeholder for session_id, which will be replaced by Stripe.
        success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_CANCEL_URL}`,
        metadata: {
          userId: userId,
          subscriptionId: subscriptionId,
          planType: planType,
        },
      });

      Logger.info(`Created Stripe checkout session ${session.id} for user ${userId}`);

      return {
        sessionId: session.id,
        sessionUrl: session.url!,
      };
    } catch (error) {
      Logger.error('Error creating Stripe checkout session:', error);
      throw new Error('Failed to create checkout session');
    }
  }

  /**
   * Complete subscription transaction and update subscription details
   * This function handles both first-time subscriptions and recurring payments
   */
  private async completeSubscriptionTransaction(params: {
    subscription: UserSubscription;
    subscriptionPlan: PlanConfig;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    amount: number;
    currency: string;
    invoiceId?: string;
    endPeriodTimestamp?: number;
    transactionType: 'initial_subscription' | 'subscription_renewal' | 'plan_change';
    billingReason?: string;
    oldPlanType?: string;
    newPlanType?: string;
    transactionStatus?: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'EXPIRED' | 'CANCELED';
    stripeSubscriptionData?: Stripe.Subscription;
  }): Promise<void> {
    const {
      subscription,
      subscriptionPlan,
      stripeCustomerId,
      stripeSubscriptionId,
      amount,
      currency,
      invoiceId,
      endPeriodTimestamp,
      transactionType,
      billingReason,
      oldPlanType,
      newPlanType,
      transactionStatus = 'COMPLETED',
      stripeSubscriptionData,
    } = params;

    try {
      // Use database transaction to ensure atomicity - both transaction and subscription updates succeed or fail together
      await AppDataSource.transaction(async (transactionalEntityManager) => {
        // Create transaction record
        const transaction = new PaymentTransaction();
        transaction.userId = subscription.userId;
        transaction.subscriptionId = subscription.id;
        transaction.planType = subscriptionPlan.name;
        transaction.amount = amount;
        transaction.currency = currency;
        transaction.status = transactionStatus;
        transaction.invoiceId = invoiceId || null;
        transaction.metadata = {
          type: transactionType,
          invoiceId: invoiceId,
          subscriptionId: subscription.id,
          billingReason: billingReason,
          oldPlanType: oldPlanType,
          newPlanType: transactionType === 'plan_change' ? subscriptionPlan.name : undefined,
        };

        // Save payment transaction
        await transactionalEntityManager.save(PaymentTransaction, transaction);

        // Mark transition as completed if this is a plan change
        if (transactionType === 'plan_change') {
          await this.markTransitionCompletedInTransaction(
            transactionalEntityManager,
            subscription.id,
            oldPlanType!,
            newPlanType!,
            invoiceId!,
            stripeSubscriptionId,
            stripeSubscriptionData,
          );
        }

        // Update subscription details
        subscription.planType = subscriptionPlan.name;
        // subscription.subscriptionStatus = 'active';
        subscription.stripeCustomerId = stripeCustomerId;
        subscription.stripeSubscriptionId = stripeSubscriptionId;
        subscription.creditsRemaining = subscriptionPlan.dailyCredits;

        // Set expiry date if period end timestamp is provided
        if (endPeriodTimestamp) {
          subscription.expiresAt = this.createDateFromTimestamp(
            endPeriodTimestamp,
            subscriptionPlan.name,
            `${transactionType} for ${invoiceId || 'checkout'}`,
          );
        }

        // Save subscription updates
        await transactionalEntityManager.save(UserSubscription, subscription);
        Logger.info(
          `Completed ${transactionType} transaction ${transaction.id} for subscription ${subscription.id} - Plan: ${subscriptionPlan.name}`,
        );
      });
    } catch (error) {
      Logger.error('Something went wrong while completing subscription transaction: ', error);
      throw new Error('Failed to complete subscription transaction');
    }
  }

  // Process checkout session completion (handles INITIAL subscription creation only)
  // Recurring payments are handled separately by handleInvoicePaid
  /**
   * Process checkout session completion.
   * Accepts the full Stripe.Checkout.Session object from the webhook event
   * to avoid redundant API calls. Only fetches subscription (for period_end)
   * and invoice (for amount) since those aren't expanded in the event by default.
   */
  async processCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
    try {
      Logger.info(
        `[STRIPE WEBHOOK] processCheckoutSession: session=${session.id}, payment_status=${
          session.payment_status
        }, customer=${session.customer}, subscription=${session.subscription}, invoice=${
          session.invoice
        }, metadata=${JSON.stringify(session.metadata)}`,
      );

      if (session.payment_status !== 'paid') {
        throw new Error(`Checkout session payment status is ${session.payment_status}, not paid`);
      }

      const { userId, subscriptionId, planType } = session.metadata!;

      if (!userId || !subscriptionId || !planType) {
        throw new Error('Missing required metadata in checkout session');
      }

      // Idempotency check: skip if we already have a transaction for this invoice
      if (session.invoice) {
        const existingTx = await this.paymentTransactionRepository.findOne({
          where: { invoiceId: session.invoice as string },
        });
        if (existingTx) {
          Logger.info(
            `[STRIPE WEBHOOK] processCheckoutSession: already processed (invoice=${session.invoice}, txId=${existingTx.id}), skipping`,
          );
          return;
        }
      }

      // Get user subscription
      const subscription = await this.userSubscriptionRepository.findOne({
        where: { id: subscriptionId },
      });

      if (!subscription) {
        throw new Error(`Subscription ${subscriptionId} not found`);
      }

      Logger.info(
        `[STRIPE WEBHOOK] processCheckoutSession: found subscription — id=${subscription.id}, userId=${userId}, currentPlan=${subscription.planType}, targetPlan=${planType}`,
      );

      // Get subscription plan from constants
      const subscriptionPlan = getSubscriptionPlan(planType);

      if (!subscriptionPlan) {
        throw new Error(`Subscription plan ${planType} not found`);
      }

      // Fetch subscription (for period_end) and invoice (for amount) in parallel
      const [stripeSubscription, invoice] = await Promise.all([
        this.stripe.subscriptions.retrieve(session.subscription as string),
        this.stripe.invoices.retrieve(session.invoice as string),
      ]);
      const endPeriodOfSubscription = stripeSubscription.items.data[0].current_period_end;
      const amount = (invoice.amount_paid || 0) / 100;
      const currency = (invoice.currency || 'usd').toUpperCase();

      Logger.info(
        `[STRIPE WEBHOOK] processCheckoutSession: amount=${amount} ${currency}, periodEnd=${new Date(
          endPeriodOfSubscription * 1000,
        ).toISOString()}`,
      );

      // Complete transaction and update subscription.
      await this.completeSubscriptionTransaction({
        subscription,
        subscriptionPlan,
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: session.subscription as string,
        amount,
        currency,
        invoiceId: invoice.id,
        endPeriodTimestamp: endPeriodOfSubscription,
        transactionType: 'initial_subscription',
        billingReason: 'subscription_create',
        transactionStatus: 'COMPLETED',
        stripeSubscriptionData: stripeSubscription,
      });

      Logger.info(
        `[STRIPE WEBHOOK] processCheckoutSession: done — userId=${userId}, plan=${planType}, amount=${amount} ${currency}, invoice=${invoice.id}`,
      );
    } catch (error) {
      Logger.error(`[STRIPE WEBHOOK] processCheckoutSession FAILED: ${error}`);
      throw error;
    }
  }

  // Handle expired checkout session
  // async handleExpiredCheckoutSession(sessionId: string): Promise<void> {
  //   try {
  //     const session = await this.stripe.checkout.sessions.retrieve(sessionId);
  //     const { userId, transactionId } = session.metadata || {};

  //     if (!userId || !transactionId) {
  //       Logger.warn(`Missing metadata in expired checkout session ${sessionId}`);
  //       return;
  //     }

  //     // Update transaction record to EXPIRED
  //     const transaction = await this.paymentTransactionRepository.findOne({
  //       where: { id: transactionId, userId, status: 'PENDING' },
  //     });

  //     if (transaction) {
  //       transaction.status = 'EXPIRED';
  //       transaction.paymentGatewayId = sessionId;
  //       await this.paymentTransactionRepository.save(transaction);

  //       Logger.info(`Marked transaction ${transactionId} as expired for checkout session ${sessionId}`);
  //     } else {
  //       Logger.warn(`Transaction ${transactionId} not found or already processed for expired session ${sessionId}`);
  //     }
  //   } catch (error) {
  //     Logger.error('Error handling expired checkout session:', error);
  //     throw error;
  //   }
  // }

  // Handle failed payment from payment intent
  // async handleFailedPayment(paymentIntentId: string): Promise<void> {
  //   try {
  //     const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

  //     // Get the checkout session associated with this payment intent
  //     const sessions = await this.stripe.checkout.sessions.list({
  //       payment_intent: paymentIntentId,
  //       limit: 1,
  //     });

  //     if (sessions.data.length === 0) {
  //       Logger.warn(`No checkout session found for failed payment intent ${paymentIntentId}`);
  //       return;
  //     }

  //     const session = sessions.data[0];
  //     const { userId, transactionId } = session.metadata || {};

  //     if (!userId || !transactionId) {
  //       Logger.warn(`Missing metadata in failed payment intent ${paymentIntentId}`);
  //       return;
  //     }

  //     // Update transaction record to FAILED
  //     const transaction = await this.paymentTransactionRepository.findOne({
  //       where: { id: transactionId, userId, status: 'PENDING' },
  //     });

  //     if (transaction) {
  //       transaction.status = 'FAILED';
  //       transaction.paymentGatewayId = paymentIntentId;
  //       transaction.metadata = {
  //         ...transaction.metadata,
  //         failureReason: paymentIntent?.last_payment_error?.message || 'Payment failed',
  //         failureCode: paymentIntent?.last_payment_error?.code || 'unknown_error',
  //       };
  //       await this.paymentTransactionRepository.save(transaction);

  //       Logger.info(`Marked transaction ${transactionId} as failed for payment intent ${paymentIntentId}`);
  //     } else {
  //       Logger.warn(
  //         `Transaction ${transactionId} not found or already processed for failed payment ${paymentIntentId}`,
  //       );
  //     }
  //   } catch (error) {
  //     Logger.error('Error handling failed payment:', error);
  //     throw error;
  //   }
  // }

  // Handle canceled payment from payment intent
  // async handleCanceledPayment(paymentIntentId: string): Promise<void> {
  //   try {
  //     const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

  //     // Get the checkout session associated with this payment intent
  //     const sessions = await this.stripe.checkout.sessions.list({
  //       payment_intent: paymentIntentId,
  //       limit: 1,
  //     });

  //     if (sessions.data.length === 0) {
  //       Logger.warn(`No checkout session found for canceled payment intent ${paymentIntentId}`);
  //       return;
  //     }

  //     const session = sessions.data[0];
  //     const { userId, transactionId } = session.metadata || {};

  //     if (!userId || !transactionId) {
  //       Logger.warn(`Missing metadata in canceled payment intent ${paymentIntentId}`);
  //       return;
  //     }

  //     // Update transaction record to CANCELED
  //     const transaction = await this.paymentTransactionRepository.findOne({
  //       where: { id: transactionId, userId, status: 'PENDING' },
  //     });

  //     if (transaction) {
  //       transaction.status = 'CANCELED';
  //       transaction.paymentGatewayId = paymentIntentId;
  //       transaction.metadata = {
  //         ...transaction.metadata,
  //         cancelationReason: paymentIntent.cancellation_reason || 'User canceled payment',
  //       };
  //       await this.paymentTransactionRepository.save(transaction);

  //       Logger.info(`Marked transaction ${transactionId} as canceled for payment intent ${paymentIntentId}`);
  //     } else {
  //       Logger.warn(
  //         `Transaction ${transactionId} not found or already processed for canceled payment ${paymentIntentId}`,
  //       );
  //     }
  //   } catch (error) {
  //     Logger.error('Error handling canceled payment:', error);
  //     throw error;
  //   }
  // }

  // // Handle subscription updates (renewal, status changes)
  // async handleSubscriptionUpdated(subscriptionId: string): Promise<void> {
  //   try {
  //     const stripeSubscription = await this.stripe.subscriptions.retrieve(subscriptionId);

  //     // Find user subscription by Stripe subscription ID
  //     const subscription = await this.userSubscriptionRepository.findOne({
  //       where: { stripeSubscriptionId: subscriptionId },
  //       relations: ['subscriptionPlan'],
  //     });

  //     if (!subscription) {
  //       Logger.warn(`User subscription not found for Stripe subscription ${subscriptionId}`);
  //       return;
  //     }

  //     // Update subscription status and renewal date
  //     subscription.subscriptionStatus = stripeSubscription.status as any;
  //     if (stripeSubscription.status === 'past_due') {
  //       // Keep subscription active but mark as past due
  //       Logger.warn(`Subscription ${subscriptionId} is past due for user ${subscription.userId}`);
  //     } else if (stripeSubscription.status === 'canceled') {
  //       // Downgrade to free plan
  //       const freePlan = await getSubscriptionPlan('FREE');
  //       if (freePlan) {
  //         subscription.planType = 'FREE';
  //         subscription.subscriptionPlanId = freePlan.id;
  //         subscription.creditsRemaining = freePlan.dailyCredits;
  //         subscription.expiresAt = null;
  //         subscription.stripeSubscriptionId = null;
  //         subscription.subscriptionStatus = null;
  //       }
  //     }

  //     await this.userSubscriptionRepository.save(subscription);
  //     Logger.info(`Updated subscription ${subscription.id} for Stripe subscription ${subscriptionId}`);
  //   } catch (error) {
  //     Logger.error(`Error handling subscription update: ${error}`);
  //     throw error;
  //   }
  // }

  /**
   * Handle successful payment (initial, renewal, or plan change).
   * Accepts the full Stripe.Invoice object from the webhook event to avoid re-fetching.
   * Race condition with checkout.session.completed is handled via idempotency (invoiceId dedup)
   * instead of blocking sleep retries.
   */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const invoiceId = invoice.id;
    try {
      Logger.info(
        `[STRIPE WEBHOOK] handleInvoicePaid: invoice=${invoiceId}, amount_paid=${
          (invoice as any).amount_paid
        }, currency=${(invoice as any).currency}, billing_reason=${(invoice as any).billing_reason}`,
      );

      // Get subscription ID from invoice parent details
      const stripeSubscriptionId =
        (invoice as any).parent?.subscription_details?.subscription || (invoice as any).subscription;

      if (!stripeSubscriptionId) {
        Logger.warn(
          `[STRIPE WEBHOOK] handleInvoicePaid: invoice ${invoiceId} is not associated with a subscription — skipping`,
        );
        return;
      }

      Logger.info(
        `[STRIPE WEBHOOK] handleInvoicePaid: looking up local subscription for stripeSubId=${stripeSubscriptionId}`,
      );
      const subscription = await this.userSubscriptionRepository.findOne({
        where: { stripeSubscriptionId: stripeSubscriptionId as string },
      });

      if (!subscription) {
        Logger.warn(
          `[STRIPE WEBHOOK] handleInvoicePaid: no local subscription for invoice=${invoiceId}, stripeSubId=${stripeSubscriptionId}. ` +
            `Likely a race with checkout.session.completed — that handler will complete the transaction.`,
        );
        return;
      }

      Logger.info(
        `[STRIPE WEBHOOK] handleInvoicePaid: found subscription — id=${subscription.id}, userId=${subscription.userId}, planType=${subscription.planType}`,
      );

      const billingReason = (invoice as any).billing_reason;

      // Check for existing transaction with this invoice ID to prevent duplicates
      const existingTransaction = await this.paymentTransactionRepository.findOne({
        where: { invoiceId },
      });

      // Fetch Stripe subscription for the authoritative price and period end
      const stripeSubscription = await this.stripe.subscriptions.retrieve(stripeSubscriptionId as string);
      const stripePriceId = stripeSubscription.items.data[0].price.id;
      const endPeriodOfSubscription = stripeSubscription.items.data[0].current_period_end;

      // Transaction already exists (created by checkout.session.completed) — just mark it COMPLETED
      if (existingTransaction) {
        Logger.info(
          `[STRIPE WEBHOOK] handleInvoicePaid: existing transaction found — txId=${existingTransaction.id}, status=${existingTransaction.status}, completing it`,
        );

        // Use transaction to ensure subscription expiry update and transaction status update are atomic
        await AppDataSource.transaction(async (transactionalEntityManager) => {
          subscription.expiresAt = this.createDateFromTimestamp(
            endPeriodOfSubscription,
            subscription.planType,
            `invoice paid for ${invoiceId}`,
          );
          await transactionalEntityManager.save(UserSubscription, subscription);

          if (existingTransaction.status === 'PENDING') {
            existingTransaction.status = 'COMPLETED';
            await transactionalEntityManager.save(PaymentTransaction, existingTransaction);
            Logger.info(
              `[STRIPE WEBHOOK] handleInvoicePaid: transaction ${existingTransaction.id} updated to COMPLETED`,
            );
          } else {
            Logger.info(
              `[STRIPE WEBHOOK] handleInvoicePaid: transaction ${existingTransaction.id} already ${existingTransaction.status}, only updated expiresAt`,
            );
          }
        });
        return;
      }

      // New transaction: monthly/yearly renewal or plan change
      const actualPlan = getSubscriptionPlanByStripePriceId(stripePriceId);

      if (!actualPlan) {
        Logger.error(`[STRIPE WEBHOOK] handleInvoicePaid: no plan found for stripePriceId=${stripePriceId}`);
        throw new Error(`Subscription plan not found for Stripe price ID: ${stripePriceId}`);
      }

      const oldPlanType = subscription.planType;
      const newPlanType = actualPlan.name;
      const isPlanChange = oldPlanType !== newPlanType;

      const amount = (invoice as any).amount_paid / 100;
      const currency = (invoice as any).currency?.toUpperCase() || 'USD';
      const transactionType = isPlanChange ? 'plan_change' : 'subscription_renewal';

      Logger.info(
        `[STRIPE WEBHOOK] handleInvoicePaid: ${transactionType} — userId=${subscription.userId}, ${
          isPlanChange ? `${oldPlanType} → ${newPlanType}` : oldPlanType
        }, amount=${amount} ${currency}`,
      );

      await this.completeSubscriptionTransaction({
        subscription,
        subscriptionPlan: actualPlan,
        stripeCustomerId: (invoice as any).customer as string,
        stripeSubscriptionId: stripeSubscriptionId as string,
        amount,
        currency,
        invoiceId,
        endPeriodTimestamp: endPeriodOfSubscription,
        transactionType: transactionType as 'subscription_renewal' | 'plan_change',
        billingReason,
        oldPlanType: isPlanChange ? oldPlanType : undefined,
        newPlanType: isPlanChange ? newPlanType : undefined,
        transactionStatus: 'COMPLETED',
        stripeSubscriptionData: stripeSubscription,
      });

      Logger.info(
        `[STRIPE WEBHOOK] handleInvoicePaid: done — userId=${subscription.userId}, ${transactionType}, invoice=${invoiceId}`,
      );
    } catch (error) {
      Logger.error(`[STRIPE WEBHOOK] handleInvoicePaid FAILED (invoice=${invoiceId}): ${error}`);
      throw error;
    }
  }

  // Handle failed recurring payment (invoice payment failed)
  async handleInvoicePaymentFailed(invoiceId: string): Promise<void> {
    try {
      Logger.info(`[STRIPE WEBHOOK] handleInvoicePaymentFailed: fetching invoice=${invoiceId}`);
      const invoice = await this.stripe.invoices.retrieve(invoiceId);

      // Get subscription ID from invoice parent details
      const subscriptionId =
        (invoice as any).parent?.subscription_details?.subscription || (invoice as any).subscription;

      if (!subscriptionId) {
        Logger.warn(
          `[STRIPE WEBHOOK] handleInvoicePaymentFailed: invoice ${invoiceId} not associated with a subscription — skipping`,
        );
        return;
      }

      const subscription = await this.userSubscriptionRepository.findOne({
        where: { stripeSubscriptionId: subscriptionId as string },
      });

      if (!subscription) {
        Logger.warn(
          `[STRIPE WEBHOOK] handleInvoicePaymentFailed: no local subscription for stripeSubId=${subscriptionId}, invoice=${invoiceId}`,
        );
        return;
      }

      const amount = invoice.amount_due ? Number(invoice.amount_due) / 100 : 0;
      const currency = invoice.currency ? invoice.currency.toUpperCase() : 'USD';
      Logger.warn(
        `[STRIPE WEBHOOK] handleInvoicePaymentFailed: userId=${subscription.userId}, plan=${subscription.planType}, amount_due=${amount} ${currency}, invoice=${invoiceId}`,
      );

      // Create a failed payment transaction record
      await this.paymentTransactionRepository.save({
        userId: subscription.userId,
        subscriptionId: subscription.id,
        planType: subscription.planType,
        amount,
        currency,
        status: 'FAILED',
        invoiceId: invoice.id,
        metadata: {
          reason: 'Invoice payment failed',
          stripeEvent: 'invoice.payment_failed',
        },
      });
      Logger.info(
        `[STRIPE WEBHOOK] handleInvoicePaymentFailed: recorded FAILED transaction — userId=${subscription.userId}, invoice=${invoiceId}`,
      );
    } catch (error) {
      Logger.error(`[STRIPE WEBHOOK] handleInvoicePaymentFailed FAILED (invoice=${invoiceId}): ${error}`);
      throw error;
    }
  }

  // Helper method to mark a transition as completed within a database transaction
  // This ensures atomicity with payment transaction and subscription updates
  private async markTransitionCompletedInTransaction(
    transactionalEntityManager: any,
    subscriptionId: string,
    oldPlanType: string,
    newPlanType: string,
    invoiceId: string,
    stripeSubscriptionId: string,
    stripeSubscriptionData?: Stripe.Subscription,
  ): Promise<void> {
    try {
      // Use pre-fetched subscription data if available, otherwise fetch from Stripe
      const stripeSubscription =
        stripeSubscriptionData ?? (await this.stripe.subscriptions.retrieve(stripeSubscriptionId));
      const transitionId = stripeSubscription?.metadata?.transitionId;
      let transition: SubscriptionTransition | null = null;

      // First, try to find transition by transitionId in Stripe metadata
      if (transitionId) {
        transition = await transactionalEntityManager.findOne(SubscriptionTransition, {
          where: { id: transitionId },
        });
      }

      // If not found by ID, try to find by subscription ID and plan change details (IN_PROGRESS)
      if (!transition) {
        transition = await transactionalEntityManager.findOne(SubscriptionTransition, {
          where: {
            subscriptionId,
            fromPlanType: oldPlanType,
            toPlanType: newPlanType,
            status: TransitionStatus.IN_PROGRESS,
          },
          order: { createdAt: 'DESC' },
        });
      }

      // Also check for PENDING transitions (scheduled downgrades that just completed)
      if (!transition) {
        transition = await transactionalEntityManager.findOne(SubscriptionTransition, {
          where: {
            subscriptionId,
            fromPlanType: oldPlanType,
            toPlanType: newPlanType,
            status: TransitionStatus.PENDING,
          },
          order: { createdAt: 'DESC' },
        });
      }

      if (transition && transition.status !== TransitionStatus.COMPLETED) {
        transition.status = TransitionStatus.COMPLETED;
        transition.completedAt = new Date();
        transition.invoiceId = invoiceId;
        await transactionalEntityManager.save(SubscriptionTransition, transition);
        Logger.info(
          `✅ Marked transition ${transition.id} as COMPLETED after invoice ${invoiceId} was paid. Plan change: ${oldPlanType} → ${newPlanType}`,
        );
      } else if (!transition) {
        Logger.warn(
          `No transition found for plan change ${oldPlanType} → ${newPlanType} on subscription ${subscriptionId}`,
        );
      }
    } catch (error) {
      Logger.error(`Error updating transition status: ${error}`);
      // Re-throw to rollback the entire transaction if transition update fails
      throw error;
    }
  }

  // Check if there's a pending or in-progress transition for a subscription
  async hasPendingTransition(subscriptionId: string): Promise<SubscriptionTransition | null> {
    try {
      const pendingTransition = await this.subscriptionTransitionRepository.findOne({
        where: [
          {
            subscriptionId,
            status: TransitionStatus.PENDING,
          },
          {
            subscriptionId,
            status: TransitionStatus.IN_PROGRESS,
          },
        ],
        order: {
          createdAt: 'DESC', // Get the most recent pending/in-progress transition
        },
      });

      return pendingTransition;
    } catch (error) {
      Logger.error(`Error checking for pending transitions: ${error}`);
      // Return null on error to allow the operation to proceed (fail open for safety)
      return null;
    }
  }

  // Update existing subscription (upgrade with immediate proration)
  async updateSubscriptionImmediately(
    subscriptionId: string,
    newPlanType: string,
    analysis?: { direction: string; rationale: string },
  ): Promise<{ success: boolean; message: string }> {
    try {
      const subscription = await this.userSubscriptionRepository.findOne({
        where: { id: subscriptionId },
      });

      if (!subscription) {
        throw new Error(`Subscription ${subscriptionId} not found`);
      }

      if (!subscription.stripeSubscriptionId) {
        throw new Error('No active Stripe subscription found. Cannot update.');
      }

      const newPlan = getSubscriptionPlan(newPlanType);
      if (!newPlan || !newPlan.stripePriceId) {
        throw new Error(`Invalid plan type or missing Stripe price ID: ${newPlanType}`);
      }

      let transition: SubscriptionTransition | null = null;
      const stripeSubscriptionId = subscription.stripeSubscriptionId!; // Already validated above
      const stripePriceId = newPlan.stripePriceId!; // Already validated above

      // Use database transaction to ensure atomicity
      // If Stripe update fails, we'll rollback the transition record
      await AppDataSource.transaction(async (transactionalEntityManager) => {
        // Create transition record within transaction
        transition = transactionalEntityManager.create(SubscriptionTransition, {
          userId: subscription.userId,
          subscriptionId: subscription.id,
          fromPlanType: subscription.planType,
          toPlanType: newPlanType,
          transitionType: TransitionType.UPGRADE,
          status: TransitionStatus.IN_PROGRESS,
          scheduledFor: null, // Immediate change
          stripeSubscriptionId: stripeSubscriptionId,
          metadata: {
            analysis,
            changeType: 'immediate_upgrade',
          },
        });
        transition = await transactionalEntityManager.save(SubscriptionTransition, transition);

        // Update Stripe subscription with proration (immediate billing)
        // This will create an invoice and attempt to charge immediately
        // If this fails, the transaction will rollback and transition will be deleted
        const stripeSubscription = await this.stripe.subscriptions.retrieve(stripeSubscriptionId);
        const currentItem = stripeSubscription.items.data[0];

        await this.stripe.subscriptions.update(stripeSubscriptionId, {
          items: [
            {
              id: currentItem.id,
              price: stripePriceId,
            },
          ],
          proration_behavior: 'create_prorations', // Create prorations for immediate billing
          billing_cycle_anchor: 'now', // Reset billing cycle immediately
          metadata: {
            ...stripeSubscription.metadata,
            pendingPlanType: newPlanType, // Track the pending plan change
            planChangeType: 'upgrade',
            transitionId: transition.id, // Link to our transition record
          },
        });

        Logger.info(
          `Updated Stripe subscription ${subscription.stripeSubscriptionId} to ${newPlanType}. ` +
            `Transition ${transition.id} recorded. Local subscription will be updated when invoice is paid via webhook.`,
        );
      });

      // NOTE: We do NOT update the local subscription record here!
      // The subscription will be updated when the invoice.paid webhook is received
      // This ensures users only get access after successful payment

      return {
        success: true,
        message: `Subscription upgrade initiated to ${newPlan.displayName}. You will be charged immediately with credit for unused time.`,
      };
    } catch (error) {
      Logger.error(`Error updating subscription immediately: ${error}`);
      // Transaction will automatically rollback if we reach here due to Stripe failure
      // Transition record will not be saved if Stripe update fails
      throw error;
    }
  }

  // Schedule subscription change for end of billing period (downgrade without proration)
  async scheduleSubscriptionChange(
    subscriptionId: string,
    newPlanType: string,
    analysis?: { direction: string; rationale: string },
  ): Promise<{ success: boolean; message: string; effectiveDate: Date | null }> {
    try {
      const subscription = await this.userSubscriptionRepository.findOne({
        where: { id: subscriptionId },
      });

      if (!subscription) {
        throw new Error(`Subscription ${subscriptionId} not found`);
      }

      if (!subscription.stripeSubscriptionId) {
        throw new Error('No active Stripe subscription found. Cannot schedule change.');
      }

      const newPlan = getSubscriptionPlan(newPlanType);
      if (!newPlan || !newPlan.stripePriceId) {
        throw new Error(`Invalid plan type or missing Stripe price ID: ${newPlanType}`);
      }

      let periodEnd: Date | null = null;
      let transition: SubscriptionTransition | null = null;
      const stripeSubscriptionId = subscription.stripeSubscriptionId!; // Already validated above
      const stripePriceId = newPlan.stripePriceId!; // Already validated above

      // Use database transaction to ensure atomicity
      // If Stripe update fails, we'll rollback the transition record
      await AppDataSource.transaction(async (transactionalEntityManager) => {
        // Get current Stripe subscription to find the period end
        const stripeSubscription = await this.stripe.subscriptions.retrieve(stripeSubscriptionId);

        // Schedule the subscription change at period end
        const currentItem = stripeSubscription.items.data[0];
        periodEnd = new Date((currentItem as any).current_period_end * 1000);

        // Determine if billing intervals are different (e.g., YEARLY -> MONTHLY)
        const currentInterval = subscription.planType.includes('YEARLY')
          ? 'year'
          : subscription.planType.includes('MONTHLY')
          ? 'month'
          : null;
        const newInterval = newPlanType.includes('YEARLY') ? 'year' : newPlanType.includes('MONTHLY') ? 'month' : null;
        const intervalsAreDifferent = currentInterval && newInterval && currentInterval !== newInterval;

        // Create transition record within transaction
        transition = transactionalEntityManager.create(SubscriptionTransition, {
          userId: subscription.userId,
          subscriptionId: subscription.id,
          fromPlanType: subscription.planType,
          toPlanType: newPlanType,
          transitionType: TransitionType.DOWNGRADE,
          status: TransitionStatus.PENDING,
          scheduledFor: periodEnd,
          stripeSubscriptionId: stripeSubscriptionId,
          metadata: {
            analysis,
            changeType: 'scheduled_downgrade',
            intervalsAreDifferent,
          },
        });
        transition = await transactionalEntityManager.save(SubscriptionTransition, transition);

        // Update Stripe subscription
        // If this fails, the transaction will rollback and transition will be deleted
        const updateParams: any = {
          items: [
            {
              id: currentItem.id,
              price: stripePriceId,
            },
          ],
          proration_behavior: 'none', // No proration - keep full payment
          billing_cycle_anchor: 'unchanged', // Don't reset billing cycle
          metadata: {
            ...stripeSubscription.metadata,
            scheduledPlanType: newPlanType, // Track the scheduled plan change
            planChangeType: 'downgrade',
            scheduledChangeDate: periodEnd.toISOString(),
            transitionId: transition.id, // Link to our transition record
          },
        };

        await this.stripe.subscriptions.update(stripeSubscriptionId, updateParams);

        Logger.info(
          `Scheduled subscription ${subscriptionId} downgrade to ${newPlanType} at period end: ${periodEnd.toISOString()}. ` +
            `Transition ${transition.id} recorded. Local subscription will be updated when next invoice is paid via webhook.`,
        );
      });

      // NOTE: We do NOT update the local subscription record here!
      // User continues with current plan until period end
      // The subscription will be updated when the next invoice.paid webhook is received

      return {
        success: true,
        message: `Subscription will be changed to ${newPlan.displayName} at the end of your current billing period. You'll continue to have access to your current plan until then.`,
        effectiveDate: periodEnd,
      };
    } catch (error) {
      Logger.error(`Error scheduling subscription change: ${error}`);
      // Transaction will automatically rollback if we reach here due to Stripe failure
      // Transition record will not be saved if Stripe update fails
      throw error;
    }
  }

  // Handle subscription deleted (cancel_at_period_end reached, or manual cancellation)
  /**
   * Handle subscription status changes (past_due, unpaid, active, etc.)
   * Syncs Stripe's subscription status to local DB so we can restrict access when needed.
   */
  async handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
    const stripeSubscriptionId = stripeSubscription.id;
    Logger.info(
      `[STRIPE WEBHOOK] handleSubscriptionDeleted called — stripeSubId=${stripeSubscriptionId}, status=${
        stripeSubscription.status
      }, customer=${stripeSubscription.customer}, cancel_reason=${
        stripeSubscription.cancellation_details?.reason ?? 'N/A'
      }, metadata=${JSON.stringify(stripeSubscription.metadata)}`,
    );

    try {
      const subscription = await this.userSubscriptionRepository.findOne({
        where: { stripeSubscriptionId },
      });

      if (!subscription) {
        Logger.warn(
          `[STRIPE WEBHOOK] handleSubscriptionDeleted: no local subscription found for stripeSubId=${stripeSubscriptionId} — may have been already cleaned up or never linked`,
        );
        return;
      }

      Logger.info(
        `[STRIPE WEBHOOK] handleSubscriptionDeleted: found local subscription — id=${subscription.id}, userId=${subscription.userId}, planType=${subscription.planType}, expiresAt=${subscription.expiresAt}`,
      );

      const oldPlanType = subscription.planType;

      // Already on FREE — nothing to do
      if (oldPlanType === 'FREE') {
        Logger.info(
          `[STRIPE WEBHOOK] handleSubscriptionDeleted: already on FREE, skipping downgrade — userId=${subscription.userId}`,
        );
        return;
      }

      // Downgrade to FREE
      const freePlan = getSubscriptionPlan('FREE');
      if (!freePlan) {
        Logger.error(
          '[STRIPE WEBHOOK] handleSubscriptionDeleted: FREE plan not found in configuration — cannot downgrade',
        );
        return;
      }

      // Use transaction to ensure subscription downgrade and transition update are atomic
      Logger.info(
        `[STRIPE WEBHOOK] handleSubscriptionDeleted: downgrading userId=${subscription.userId} from ${oldPlanType} to FREE`,
      );
      await AppDataSource.transaction(async (transactionalEntityManager) => {
        subscription.planType = 'FREE';
        subscription.creditsRemaining = freePlan.dailyCredits;
        subscription.expiresAt = null;
        subscription.stripeSubscriptionId = null;
        subscription.lastResetAt = new Date();
        await transactionalEntityManager.save(UserSubscription, subscription);

        Logger.info(
          `[STRIPE WEBHOOK] handleSubscriptionDeleted: subscription updated — userId=${subscription.userId}, ${oldPlanType} → FREE, credits=${freePlan.dailyCredits}`,
        );

        // Mark any pending transition to FREE as completed
        const pendingTransition = await transactionalEntityManager.findOne(SubscriptionTransition, {
          where: {
            subscriptionId: subscription.id,
            toPlanType: 'FREE',
            status: TransitionStatus.PENDING,
          },
          order: { createdAt: 'DESC' },
        });

        if (pendingTransition) {
          pendingTransition.status = TransitionStatus.COMPLETED;
          pendingTransition.completedAt = new Date();
          await transactionalEntityManager.save(SubscriptionTransition, pendingTransition);
          Logger.info(
            `[STRIPE WEBHOOK] handleSubscriptionDeleted: transition ${pendingTransition.id} marked COMPLETED — userId=${subscription.userId}`,
          );
        } else {
          Logger.info(
            `[STRIPE WEBHOOK] handleSubscriptionDeleted: no pending FREE transition found for subscriptionId=${subscription.id} — nothing to complete`,
          );
        }
      });
      Logger.info(
        `[STRIPE WEBHOOK] handleSubscriptionDeleted: done — userId=${subscription.userId}, stripeSubId=${stripeSubscriptionId}`,
      );
    } catch (error) {
      Logger.error(`[STRIPE WEBHOOK] handleSubscriptionDeleted FAILED — stripeSubId=${stripeSubscriptionId}:`, error);
      throw error;
    }
  }

  // Handle webhook events from Stripe
  /**
   * Verify webhook signature synchronously. Call this BEFORE responding 200 to Stripe.
   * Throws if signature is invalid.
   */
  verifyWebhookSignature(payload: string | Buffer, signature: string): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }
    return this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  /**
   * Process a verified webhook event asynchronously (called AFTER responding 200 to Stripe).
   * Errors are logged but not thrown to the HTTP layer.
   */
  async processWebhookEvent(event: Stripe.Event): Promise<void> {
    const startTime = Date.now();
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          Logger.info(
            `[STRIPE WEBHOOK] Processing checkout.session.completed — session=${session.id}, customer=${
              session.customer
            }, payment_status=${session.payment_status}, metadata=${JSON.stringify(session.metadata)}`,
          );
          await this.processCheckoutSession(session);
          Logger.info(
            `[STRIPE WEBHOOK] checkout.session.completed processed successfully — session=${session.id}, took ${
              Date.now() - startTime
            }ms`,
          );
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object as Stripe.Invoice;
          Logger.info(
            `[STRIPE WEBHOOK] Processing invoice.paid — invoice=${invoice.id}, amount_paid=${
              (invoice as any).amount_paid
            }, currency=${(invoice as any).currency}, billing_reason=${(invoice as any).billing_reason}, subscription=${
              (invoice as any).parent?.subscription_details?.subscription || (invoice as any).subscription
            }`,
          );
          await this.handleInvoicePaid(invoice);
          Logger.info(
            `[STRIPE WEBHOOK] invoice.paid processed successfully — invoice=${invoice.id}, took ${
              Date.now() - startTime
            }ms`,
          );
          break;
        }

        case 'invoice.payment_failed': {
          const failedInvoice = event.data.object as Stripe.Invoice;
          Logger.warn(
            `[STRIPE WEBHOOK] Processing invoice.payment_failed — invoice=${failedInvoice.id}, amount_due=${
              failedInvoice.amount_due
            }, subscription=${
              (failedInvoice as any).parent?.subscription_details?.subscription || (failedInvoice as any).subscription
            }`,
          );
          await this.handleInvoicePaymentFailed(failedInvoice.id as string);
          Logger.info(
            `[STRIPE WEBHOOK] invoice.payment_failed processed — invoice=${failedInvoice.id}, took ${
              Date.now() - startTime
            }ms`,
          );
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          Logger.info(
            `[STRIPE WEBHOOK] Processing customer.subscription.deleted — stripeSubId=${sub.id}, status=${sub.status}, customer=${sub.customer}`,
          );
          await this.handleSubscriptionDeleted(sub);
          Logger.info(
            `[STRIPE WEBHOOK] customer.subscription.deleted processed successfully — stripeSubId=${sub.id}, took ${
              Date.now() - startTime
            }ms`,
          );
          break;
        }

        // invoice_payment.paid fires on the newer InvoicePayment object (not Invoice).
        // We already handle the equivalent invoice.paid event, so this is a no-op.
        case 'invoice_payment.paid' as any:
          Logger.info(`[STRIPE WEBHOOK] Skipping invoice_payment.paid (handled via invoice.paid) — event=${event.id}`);
          break;

        default:
          Logger.info(`[STRIPE WEBHOOK] Unhandled event type: ${event.type} — event=${event.id}`);
      }
    } catch (error) {
      Logger.error(
        `[STRIPE WEBHOOK] Error processing ${event.type} (event=${event.id}) after ${Date.now() - startTime}ms:`,
        error,
      );
      throw error; // Re-throw so the controller returns 500 and Stripe retries
    }
  }
}

/* eslint-enable */

// Export singleton instance
export const paymentService = new PaymentService();
