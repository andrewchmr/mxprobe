// Best-effort side channels: a Telegram ping to the operator, an email
// through Resend, and a Sequenzy transactional template (the low-credit mail,
// whose copy lives in the Sequenzy dashboard). Unconfigured means a silent
// no-op; a failure is logged and returns false. Nothing here can fail a request.
import { errorMessage } from "mxprobe-core";
import type { FetchLike, Logger } from "./types.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface Template {
  to: string;
  /** The template's API slug in Sequenzy. */
  slug: string;
  variables: Record<string, string | number>;
  /** The same key never sends twice (Sequenzy keeps it 14 days). */
  idempotencyKey: string;
}

export interface Notifier {
  readonly configured: { telegram: boolean; email: boolean; templates: boolean };
  /** True when the message was accepted; false when unconfigured or failed. */
  telegram(text: string): Promise<boolean>;
  email(mail: Mail): Promise<boolean>;
  template(t: Template): Promise<boolean>;
}

export interface NotifierDeps {
  fetchImpl?: FetchLike;
  log?: Logger;
}

export function createNotifier(env: NodeJS.ProcessEnv = process.env, { fetchImpl = fetch, log = console }: NotifierDeps = {}): Notifier {
  const tgToken = env.TELEGRAM_BOT_TOKEN;
  const tgChat = env.TELEGRAM_CHAT_ID;
  const resendKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM || "MX Probe <hello@mxprobe.dev>";
  const prefix = env.TELEGRAM_PREFIX ?? "[mxprobe]";
  const sequenzyKey = env.SEQUENZY_API_KEY;
  const sequenzyUrl = (env.SEQUENZY_API_URL || "https://api.sequenzy.com/api/v1").replace(/\/$/, "");

  return {
    configured: { telegram: !!(tgToken && tgChat), email: !!resendKey, templates: !!sequenzyKey },

    async telegram(text) {
      if (!tgToken || !tgChat) return false;
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text: `${prefix} ${text}`, disable_web_page_preview: true }),
        });
        if (res.ok) return true;
        log.error("[notify] telegram", res.status, await res.text().catch(() => ""));
      } catch (err) {
        log.error("[notify] telegram failed:", errorMessage(err));
      }
      return false;
    },

    async email({ to, subject, text, replyTo }) {
      if (!resendKey) return false;
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
        if (res.ok) return true;
        log.error("[notify] resend", res.status, await res.text().catch(() => ""));
      } catch (err) {
        log.error("[notify] resend failed:", errorMessage(err));
      }
      return false;
    },

    async template({ to, slug, variables, idempotencyKey }) {
      if (!sequenzyKey) return false;
      try {
        const res = await fetchImpl(`${sequenzyUrl}/transactional/send`, {
          method: "POST",
          headers: { authorization: `Bearer ${sequenzyKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
          // The buy link is the point of the mail: no click-tracking redirect in front of it.
          body: JSON.stringify({ to, slug, variables, trackingSettings: { clickTracking: false } }),
        });
        if (res.ok) return true;
        log.error("[notify] sequenzy", res.status, await res.text().catch(() => ""));
      } catch (err) {
        log.error("[notify] sequenzy failed:", errorMessage(err));
      }
      return false;
    },
  };
}

export interface MailBody {
  subject: string;
  text: string;
}

export interface SignupMail {
  key: string;
  credits: number;
  /** Why the key has no free checks, when it has none. */
  noFreeReason?: string | null;
  buyUrl: string;
  apiUrl: string;
  siteUrl: string;
}

export function signupEmail({ key, credits, noFreeReason, buyUrl, apiUrl, siteUrl }: SignupMail): MailBody {
  const carries = noFreeReason ? `It has no free checks: ${noFreeReason}. Buy 10,000 checks for 9 USD here:\n\n  ${buyUrl}\n\nThen use it` : `It carries ${credits} free checks. Use it`;
  return {
    subject: "Your MX Probe API key",
    text: `Here is your MX Probe API key. Keep it private; it is shown only here.

  ${key}

${carries} as a bearer token:

  curl ${apiUrl}/v1/verify \\
    -H "Authorization: Bearer ${key}" \\
    -H "Content-Type: application/json" \\
    -d '{"emails":["hello@example.com"]}'

Or from the CLI and MCP server: npx mxprobe check --hosted hello@example.com

More checks are 9 USD per 10,000, one payment, they never expire.
Your payment link, good for this key at any time:

  ${buyUrl}

Docs: ${siteUrl}
Questions or a bug: reply to this email.`,
  };
}

export function purchaseEmail({ credits, total, apiUrl }: { credits: number; total: number; apiUrl: string }): MailBody {
  return {
    subject: `MX Probe: ${credits.toLocaleString("en-US")} checks added`,
    text: `Payment received. ${credits.toLocaleString("en-US")} checks were added to your key; it now holds ${total.toLocaleString("en-US")}.

Check any time with GET ${apiUrl}/v1/balance or \`npx mxprobe balance\`.

Thank you. Reply to this email if anything looks wrong.`,
  };
}
