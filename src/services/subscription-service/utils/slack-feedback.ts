import axios from 'axios';
import Logger from '../../../lib/logger';
import type { AppSumoReviewAction } from '../entity/appsumo-review-prompt';

interface SlackPayload {
  action: AppSumoReviewAction;
  rating: number | null;
  feedback: string | null;
  clickedReview: boolean;
  userId: string;
  userEmail?: string | null;
  licenseKey?: string | null;
  tier?: number | null;
}

// Only high-signal actions reach Slack. Low-signal funnel events
// (NEEDS_MORE_TIME, DISMISSED) are still recorded in `appsumo_review_prompt`
// — query the table when you want funnel stats.
const ACTION_META: Partial<Record<AppSumoReviewAction, { emoji: string; label: string }>> = {
  POSITIVE: { emoji: ':star2:', label: 'Positive review (>=8)' },
  NEGATIVE: { emoji: ':warning:', label: 'Negative review (<8)' },
};

/**
 * Fire-and-forget Slack notification for AppSumo review prompt activity.
 * Silently no-ops if SLACK_APPSUMO_FEEDBACK_WEBHOOK is not set, or if the
 * action is not in ACTION_META (NEEDS_MORE_TIME / DISMISSED are skipped).
 */
export function sendAppSumoReviewSlack(payload: SlackPayload): void {
  const webhookUrl = process.env.SLACK_APPSUMO_FEEDBACK_WEBHOOK;
  if (!webhookUrl) return;

  const meta = ACTION_META[payload.action];
  if (!meta) return;
  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Action*\n${meta.label}` },
    { type: 'mrkdwn', text: `*User*\n${payload.userEmail ?? payload.userId}` },
  ];
  if (payload.rating !== null) {
    fields.push({ type: 'mrkdwn', text: `*Rating*\n${payload.rating}/10` });
  }
  if (payload.tier) {
    fields.push({ type: 'mrkdwn', text: `*Tier*\nAppSumo T${payload.tier}` });
  }
  if (payload.action === 'POSITIVE') {
    fields.push({ type: 'mrkdwn', text: `*Clicked through to AppSumo*\n${payload.clickedReview ? 'Yes' : 'No'}` });
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${meta.emoji} AppSumo review prompt` },
    },
    { type: 'section', fields },
  ];

  if (payload.feedback) {
    // Slack section blocks cap text at 3000 chars. We also expand each
    // newline into `\n>` (block-quote prefix), which inflates length.
    // Build the full string, then hard-clamp to 3000 with an ellipsis
    // so the POST never fails with `invalid_blocks`.
    const SLACK_SECTION_MAX = 3000;
    const ELLIPSIS = '\n… [truncated]';
    let rendered = `*Feedback*\n>${payload.feedback.replace(/\n/g, '\n>')}`;
    if (rendered.length > SLACK_SECTION_MAX) {
      rendered = rendered.slice(0, SLACK_SECTION_MAX - ELLIPSIS.length) + ELLIPSIS;
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: rendered },
    });
  }

  const text = `${meta.emoji} AppSumo: ${meta.label} — ${payload.userEmail ?? payload.userId}${
    payload.rating !== null ? ` (${payload.rating}/10)` : ''
  }`;

  axios.post(webhookUrl, { text, blocks }, { timeout: 5000 }).catch((err) => {
    Logger.warn(`[SLACK] AppSumo feedback webhook failed: ${(err as Error).message}`);
  });
}
