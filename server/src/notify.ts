// Best-effort side channels: a Telegram ping to the operator and an email
// through Resend. Unconfigured means a silent no-op; a failure is logged and
// returns false. Nothing here can fail a request.
import { errorMessage } from "mxprobe-core";
import type { FetchLike, Logger } from "./types.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface Notifier {
  readonly configured: { telegram: boolean; email: boolean };
  /** True when the message was accepted; false when unconfigured or failed. */
  telegram(text: string): Promise<boolean>;
  email(mail: Mail): Promise<boolean>;
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

  return {
    configured: { telegram: !!(tgToken && tgChat), email: !!resendKey },

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
  };
}

export interface MailBody {
  subject: string;
  text: string;
}

export function signupEmail({ key, credits, apiUrl, siteUrl }: { key: string; credits: number; apiUrl: string; siteUrl: string }): MailBody {
  return {
    subject: "Your MX Probe API key",
    text: `Here is your MX Probe API key. Keep it private; it is shown only here.

  ${key}

It carries ${credits} free checks. Use it as a bearer token:

  curl ${apiUrl}/v1/verify \\
    -H "Authorization: Bearer ${key}" \\
    -H "Content-Type: application/json" \\
    -d '{"emails":["hello@example.com"]}'

Or from the CLI and MCP server: npx mxprobe check --hosted hello@example.com

More checks are 9 USD per 10,000, one payment, they never expire:
POST ${apiUrl}/v1/credits/checkout with the same header returns a payment link.

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
