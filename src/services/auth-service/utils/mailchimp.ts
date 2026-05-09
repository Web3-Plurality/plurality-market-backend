import axios from 'axios';
import crypto from 'crypto';
import Logger from '../../../lib/logger';

const MAILCHIMP_API_KEY = process.env.MAILCHIMP_API_KEY || '';
const MAILCHIMP_AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID || '';
const MAILCHIMP_SERVER_PREFIX = process.env.MAILCHIMP_SERVER_PREFIX || '';
const MAILCHIMP_SIGNUP_TAG = process.env.MAILCHIMP_SIGNUP_TAG || '';

function getMailchimpBaseUrl(): string {
  return `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0`;
}

function getMailchimpHeaders() {
  return {
    Authorization: `apikey ${MAILCHIMP_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function emailToSubscriberHash(email: string): string {
  return crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Add a subscriber to Mailchimp with the 'Extension Users' tag.
 * Fires and forgets — signup should never fail because of Mailchimp.
 */
export async function addMailchimpSubscriber(email: string): Promise<void> {
  if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID || !MAILCHIMP_SERVER_PREFIX) {
    Logger.warn('[Mailchimp] API key or audience ID not configured, skipping subscriber add');
    return;
  }

  if (!email) {
    return;
  }

  try {
    await axios.post(
      `${getMailchimpBaseUrl()}/lists/${MAILCHIMP_AUDIENCE_ID}/members`,
      {
        email_address: email,
        status: 'subscribed',
        tags: MAILCHIMP_SIGNUP_TAG ? [MAILCHIMP_SIGNUP_TAG] : [],
      },
      { headers: getMailchimpHeaders() },
    );
    Logger.info(`[Mailchimp] Subscriber added: ${email}`);
  } catch (error: any) {
    // 400 with "Member Exists" is expected if re-signing up — not an error
    if (error?.response?.data?.title === 'Member Exists') {
      Logger.info(`[Mailchimp] Subscriber already exists: ${email}, applying tag`);
      if (MAILCHIMP_SIGNUP_TAG) {
        addMailchimpTag(email, MAILCHIMP_SIGNUP_TAG);
      }
    } else {
      Logger.error(`[Mailchimp] Failed to add subscriber: ${error?.response?.data?.detail || error.message}`);
    }
  }
}

/**
 * Add a tag to an existing Mailchimp subscriber.
 * Uses the tags endpoint which auto-creates tags if they don't exist.
 * Fire-and-forget — never blocks the calling flow.
 */
export async function addMailchimpTag(email: string, tag: string): Promise<void> {
  if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID || !MAILCHIMP_SERVER_PREFIX) {
    Logger.warn('[Mailchimp] Not configured, skipping tag add');
    return;
  }

  if (!email || !tag) {
    return;
  }

  const subscriberHash = emailToSubscriberHash(email);

  try {
    await axios.post(
      `${getMailchimpBaseUrl()}/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}/tags`,
      {
        tags: [{ name: tag, status: 'active' }],
      },
      { headers: getMailchimpHeaders() },
    );
    Logger.info(`[Mailchimp] Tag '${tag}' added to ${email}`);
  } catch (error: any) {
    Logger.error(`[Mailchimp] Failed to add tag '${tag}': ${error?.response?.data?.detail || error.message}`);
  }
}
