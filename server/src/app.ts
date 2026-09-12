// The HTTP app: a request handler over node:http. Built by createApp() with
// its dependencies passed in, so the tests run it against an in-memory
// database, a canned verifier and fake Stripe, Resend and Telegram.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { parseAddress, checkDomain, errorMessage, summarize, type ApiErrorBody, type BalanceResponse, type CheckoutResponse, type Resolver, type SignupResponse, type Verifier, type VerifyResponse } from "mxprobe-core";
import { createBuckets } from "./ratelimit.ts";
import { isDisposableDomain } from "./disposable.ts";
import { createCheckoutSession, verifyStripeSignature } from "./stripe.ts";
import { signupEmail, purchaseEmail, type Notifier } from "./notify.ts";
import type { Db, KeyRow } from "./db.ts";
import type { FetchLike, Logger } from "./types.ts";

/** The server version, read from package.json so a bump is one edit there. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const MAX_BODY = 64 * 1024;
const MAX_EMAILS = 100;

type Extra = Omit<ApiErrorBody, "error" | "message">;

export class HttpError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, error: string, message: string, extra: Extra = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = { error, message, ...extra };
  }
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface NewApiKey {
  key: string;
  hash: string;
  prefix: string;
}

export function newApiKey(): NewApiKey {
  const key = `mxp_${randomBytes(16).toString("hex")}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}

export interface AppConfig {
  freeCredits: number;
  packCredits: number;
  packUsd: number;
  checksPerMinute: number;
  signupsPerDayPerIp: number;
  siteUrl: string;
  apiUrl: string;
  /** Read the client IP from X-Forwarded-For (set behind Caddy). */
  trustProxy: boolean;
  stripeSecretKey: string | null;
  stripePriceId: string | null;
  stripeWebhookSecret: string | null;
  /** For tests: the resolver the signup deliverability check uses. */
  resolver?: Resolver;
}

export interface AppDeps {
  db: Db;
  verifier: Pick<Verifier, "verifyBatch">;
  notifier: Notifier;
  config?: Partial<AppConfig>;
  fetchImpl?: FetchLike;
  log?: Logger;
  now?: () => number;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type JsonObject = Record<string, unknown>;
type Reply = readonly [status: number, body: unknown];
type Route = (req: IncomingMessage) => Reply | Promise<Reply>;

interface StripeCheckoutSession {
  id?: string;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string | undefined>;
}

interface StripeEvent {
  id: string;
  type: string;
  data?: { object?: StripeCheckoutSession };
}

const isJsonObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown[]): v is string[] => v.every((e) => typeof e === "string");
const isStripeEvent = (v: unknown): v is StripeEvent => isJsonObject(v) && typeof v["id"] === "string" && typeof v["type"] === "string";

export function createApp({ db, verifier, notifier, config, fetchImpl = fetch, log = console, now = () => Date.now() }: AppDeps): RequestHandler {
  const cfg: AppConfig = {
    freeCredits: 100,
    packCredits: 10_000,
    packUsd: 9,
    checksPerMinute: 60,
    signupsPerDayPerIp: 3,
    siteUrl: "https://mxprobe.dev",
    apiUrl: "https://api.mxprobe.dev",
    trustProxy: false,
    stripeSecretKey: null,
    stripePriceId: null,
    stripeWebhookSecret: null,
    ...config,
  };
  const checkBuckets = createBuckets({ capacity: cfg.checksPerMinute, refillPerSec: cfg.checksPerMinute / 60, now });
  const publicBuckets = createBuckets({ capacity: 10, refillPerSec: 10 / 3600, now });
  const startedAt = now();
  const paymentsConfigured = !!(cfg.stripeSecretKey && cfg.stripePriceId);

  // ------------------------------------------------------------ helpers

  function clientIp(req: IncomingMessage): string {
    if (cfg.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = String(xff ?? "").split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket?.remoteAddress ?? "unknown";
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      req.on("data", (c: Buffer) => {
        if (overflow) return; // keep draining so the 413 can be written and the socket reused
        size += c.length;
        if (size > MAX_BODY) {
          overflow = true;
          chunks.length = 0;
          reject(new HttpError(413, "body_too_large", `Body over ${MAX_BODY} bytes`));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function readJson(req: IncomingMessage): Promise<JsonObject> {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Body must be a JSON object");
    }
    if (!isJsonObject(v)) throw new HttpError(400, "invalid_json", "Body must be a JSON object");
    return v;
  }

  function authenticate(req: IncomingMessage): KeyRow {
    const auth = req.headers.authorization ?? "";
    const header = req.headers["x-api-key"];
    const key = auth.match(/^Bearer\s+(\S+)$/i)?.[1] ?? (Array.isArray(header) ? header[0] : header);
    if (!key) throw new HttpError(401, "missing_api_key", 'Send the key as Authorization: Bearer <key>. No key yet? POST /v1/signup {"email"}.');
    const row = db.keyByHash(hashKey(String(key)));
    if (!row) throw new HttpError(401, "invalid_api_key", "That API key is not known");
    if (row.revoked) throw new HttpError(403, "key_revoked", "This key was revoked. Write to hello@mxprobe.dev.");
    return row;
  }

  function publicLimit(req: IncomingMessage, what: string): void {
    const r = publicBuckets.take(`${what}:${clientIp(req)}`);
    if (!r.ok) throw new HttpError(429, "rate_limited", `Too many ${what} requests from this address`, { retry_after_seconds: r.retryAfterSec });
  }

  const checkoutHint = `POST ${cfg.apiUrl}/v1/credits/checkout returns a payment link: ${cfg.packUsd} USD per ${cfg.packCredits.toLocaleString("en-US")} checks, credits never expire.`;

  // ------------------------------------------------------------ handlers

  async function signup(req: IncomingMessage): Promise<Reply> {
    publicLimit(req, "signup");
    const body = await readJson(req);
    const parsed = parseAddress(body["email"]);
    if (parsed.error !== undefined) throw new HttpError(400, "invalid_email", `email: ${parsed.error}`);
    // One key per mailbox: the whole address is compared case-insensitively.
    const email = parsed.email.toLowerCase();
    const { domain } = parsed;
    if (isDisposableDomain(domain)) throw new HttpError(422, "disposable_domain", "Sign up with an address you will keep; the key is mailed there.");

    const ip = clientIp(req);
    const since = new Date(now() - 24 * 3600 * 1000).toISOString();
    if (db.signupsFromIp(ip, since) >= cfg.signupsPerDayPerIp) {
      throw new HttpError(429, "too_many_signups", `At most ${cfg.signupsPerDayPerIp} signups a day from one address`);
    }
    if (db.keyByEmail(email)) {
      throw new HttpError(409, "already_registered", "This address already has a key; it was mailed at signup. Lost it? Reply to that email or write to hello@mxprobe.dev.");
    }
    const dns = await checkDomain(domain, { resolver: cfg.resolver });
    if (dns.verdict === "DEAD") throw new HttpError(422, "undeliverable_email", `That address cannot receive the key: ${dns.reason}`);

    const { key, hash, prefix } = newApiKey();
    let row: KeyRow;
    try {
      row = db.createKey({ email, keyHash: hash, keyPrefix: prefix, credits: cfg.freeCredits, ip });
    } catch (err) {
      if (/UNIQUE/.test(errorMessage(err))) throw new HttpError(409, "already_registered", "This address already has a key.");
      throw err;
    }
    const mail = signupEmail({ key, credits: cfg.freeCredits, apiUrl: cfg.apiUrl, siteUrl: cfg.siteUrl });
    const mailed = await notifier.email({ to: email, ...mail, replyTo: "hello@mxprobe.dev" });
    void notifier.telegram(`signup ${email} (${prefix}…) from ${ip}${mailed ? "" : ", key email FAILED"}`);
    log.info(`[signup] ${prefix} ${email} ip=${ip} mailed=${mailed}`);
    const res: SignupResponse = {
      api_key: key,
      email,
      credits: row.credits,
      mailed,
      message: `Keep this key; it is shown once${mailed ? " and was mailed to you" : ""}. Send it as Authorization: Bearer <key>. ${cfg.freeCredits} free checks are on it.`,
    };
    return [201, res];
  }

  async function verify(req: IncomingMessage): Promise<Reply> {
    const keyRow = authenticate(req);
    const body = await readJson(req);
    const raw: unknown[] | null = Array.isArray(body["emails"]) ? body["emails"] : typeof body["email"] === "string" ? [body["email"]] : null;
    if (!raw || raw.length === 0) throw new HttpError(400, "no_emails", 'Send {"emails": ["a@b.com", ...]} or {"email": "a@b.com"}');
    if (raw.length > MAX_EMAILS) throw new HttpError(400, "too_many_emails", `At most ${MAX_EMAILS} addresses per call`, { max: MAX_EMAILS });
    if (!isStringArray(raw)) throw new HttpError(400, "invalid_emails", "Every entry must be a string");
    const emails = [...new Set(raw.map((e) => e.trim()))];

    const billable = emails.filter((e) => parseAddress(e).error === undefined).length;
    const rl = checkBuckets.take(keyRow.id, billable);
    if (!rl.ok) throw new HttpError(429, "rate_limited", `${cfg.checksPerMinute} checks a minute per key`, { retry_after_seconds: rl.retryAfterSec });

    if (!db.chargeCredits(keyRow.id, billable)) {
      const fresh = db.keyById(keyRow.id) ?? keyRow;
      throw new HttpError(402, "insufficient_credits", `This call needs ${billable} credits and the key has ${fresh.credits}.`, {
        credits_left: fresh.credits,
        needed: billable,
        checkout_hint: checkoutHint,
      });
    }

    const t0 = now();
    const results = await verifier.verifyBatch(emails);
    const ms = now() - t0;

    // We could not even reach the mail server: that check is on us, not on the customer.
    const refund = results.filter((r) => r.checks.smtp === "unreachable").length;
    if (refund > 0) db.addCredits(keyRow.id, refund, "refund", "unreachable");
    db.logVerify(keyRow.id, results, ms);
    const after = db.keyById(keyRow.id) ?? keyRow;
    const summary = summarize(results);
    log.info(`[verify] ${keyRow.key_prefix} n=${results.length} send=${summary.send} hold=${summary.hold} kill=${summary.kill} ms=${ms} refund=${refund}`);
    const res: VerifyResponse = { results, summary, credits_used: billable - refund, credits_left: after.credits };
    return [200, res];
  }

  function balance(req: IncomingMessage): Reply {
    const k = authenticate(req);
    const res: BalanceResponse = { email: k.email, credits: k.credits, checks_total: k.checks_total, created_at: k.created_at };
    return [200, res];
  }

  async function checkout(req: IncomingMessage): Promise<Reply> {
    const k = authenticate(req);
    const body = await readJson(req);
    const packs = Math.min(100, Math.max(1, Number.parseInt(String(body["packs"] ?? 1), 10) || 1));
    if (!cfg.stripeSecretKey || !cfg.stripePriceId) throw new HttpError(503, "payments_not_configured", "Payments are not set up on this server yet");
    const credits = packs * cfg.packCredits;
    const session = await createCheckoutSession({
      secretKey: cfg.stripeSecretKey,
      priceId: cfg.stripePriceId,
      quantity: packs,
      keyId: k.id,
      email: k.email,
      successUrl: `${cfg.siteUrl}/paid`,
      cancelUrl: `${cfg.siteUrl}/`,
      description: `MX Probe: ${credits.toLocaleString("en-US")} email checks`,
      fetchImpl,
    });
    log.info(`[checkout] ${k.key_prefix} packs=${packs} session=${session.id}`);
    const res: CheckoutResponse = { url: session.url, credits, amount_usd: packs * cfg.packUsd, packs, session_id: session.id, message: "Open the URL to pay. Credits land on the key when Stripe confirms the payment." };
    return [200, res];
  }

  async function stripeWebhook(req: IncomingMessage): Promise<Reply> {
    if (!cfg.stripeWebhookSecret) throw new HttpError(503, "webhook_not_configured", "STRIPE_WEBHOOK_SECRET is unset");
    const raw = await readBody(req);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], cfg.stripeWebhookSecret, { nowSec: now() / 1000 })) {
      throw new HttpError(400, "invalid_signature", "Stripe signature did not verify");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Event body is not JSON");
    }
    if (!isStripeEvent(parsed)) throw new HttpError(400, "invalid_json", "Event body is not a Stripe event");
    const event = parsed;
    if (!db.claimStripeEvent(event.id, event.type)) return [200, { received: true, duplicate: true }];
    try {
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const s = event.data?.object ?? {};
        // "no_payment_required" is what Stripe sends when a 100% promotion brings the total to zero.
        if (s.payment_status === "paid" || s.payment_status === "no_payment_required") {
          const keyId = Number(s.metadata?.["key_id"] ?? s.client_reference_id);
          const packs = Number(s.metadata?.["packs"] ?? 1);
          const k = db.keyById(keyId);
          if (!k) throw new Error(`webhook: no key with id ${keyId}`);
          const credits = packs * cfg.packCredits;
          const after = db.addCredits(k.id, credits, "purchase", s.id ?? null);
          const amount = s.amount_total != null ? `${(s.amount_total / 100).toFixed(2)} ${String(s.currency ?? "usd").toUpperCase()}` : "?";
          void notifier.email({ to: k.email, ...purchaseEmail({ credits, total: after.credits, apiUrl: cfg.apiUrl }), replyTo: "hello@mxprobe.dev" });
          void notifier.telegram(`PAID ${amount} by ${k.email}: +${credits.toLocaleString("en-US")} checks (${after.credits.toLocaleString("en-US")} on the key)`);
          log.info(`[stripe] paid ${k.key_prefix} +${credits} session=${s.id}`);
        }
      }
    } catch (err) {
      db.releaseStripeEvent(event.id);
      throw err;
    }
    return [200, { received: true }];
  }

  async function subscribe(req: IncomingMessage): Promise<Reply> {
    publicLimit(req, "subscribe");
    const body = await readJson(req);
    const parsed = parseAddress(body["email"]);
    if (parsed.error !== undefined) throw new HttpError(400, "invalid_email", `email: ${parsed.error}`);
    const fresh = db.addSubscriber(parsed.email.toLowerCase(), clientIp(req));
    if (fresh) void notifier.telegram(`subscriber ${parsed.email}`);
    return [200, { ok: true }];
  }

  async function feedback(req: IncomingMessage): Promise<Reply> {
    publicLimit(req, "feedback");
    const body = await readJson(req);
    const message = String(body["message"] ?? "")
      .trim()
      .slice(0, 2000);
    if (!message) throw new HttpError(400, "empty_message", "message is required");
    const parsed = typeof body["email"] === "string" ? parseAddress(body["email"]) : null;
    const email = parsed && parsed.error === undefined ? parsed.email : null;
    db.addFeedback(email, message, clientIp(req));
    void notifier.telegram(`feedback from ${email ?? "anonymous"}:\n${message}`);
    return [200, { ok: true }];
  }

  function health(): Reply {
    db.keyById(0); // proves the database answers
    return [200, { ok: true, version: VERSION, uptime_s: Math.round((now() - startedAt) / 1000), notifier: notifier.configured, payments: paymentsConfigured }];
  }

  function index(): Reply {
    return [
      200,
      {
        name: "MX Probe API",
        version: VERSION,
        docs: cfg.siteUrl,
        openapi: `${cfg.siteUrl}/openapi.json`,
        llms_txt: `${cfg.siteUrl}/llms.txt`,
        pricing: `${cfg.freeCredits} free checks at signup, then ${cfg.packUsd} USD per ${cfg.packCredits.toLocaleString("en-US")} checks, one payment, no expiry`,
        endpoints: {
          "POST /v1/signup": '{"email"} -> {api_key, credits}. No auth.',
          "POST /v1/verify": '{"emails": [...]} (max 100) -> {results, summary, credits_used, credits_left}. Bearer key. 1 credit per address.',
          "GET /v1/balance": "-> {email, credits, checks_total}. Bearer key.",
          "POST /v1/credits/checkout": '{"packs": 1} -> {url}. Bearer key. Pay at the URL; credits land on confirmation.',
        },
        verdict: { action: ["send", "hold", "kill"], verdict: ["OK", "WEAK", "DEAD"], checks: ["syntax", "mx", "smtp", "catch_all"] },
        privacy: "Addresses are logged for 24 hours for debugging, then deleted. They never leave the server except to the mail exchanger being asked.",
      },
    ];
  }

  const routes: Readonly<Record<string, Route>> = {
    "GET /": index,
    "GET /v1": index,
    "GET /v1/health": health,
    "POST /v1/signup": signup,
    "POST /v1/verify": verify,
    "GET /v1/balance": balance,
    "POST /v1/credits/checkout": checkout,
    "POST /v1/stripe/webhook": stripeWebhook,
    "POST /v1/subscribe": subscribe,
    "POST /v1/feedback": feedback,
  };

  // ------------------------------------------------------------ dispatcher

  return async function handle(req, res) {
    const t0 = now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key");
    res.setHeader("access-control-max-age", "86400");
    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    let status = 500;
    let body: unknown;
    try {
      const route = routes[`${method} ${path}`];
      if (!route) throw new HttpError(404, "not_found", `No route ${method} ${path}. GET / lists the endpoints.`);
      [status, body] = await route(req);
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        body = err.body;
        if (err.status === 429 && err.body.retry_after_seconds) res.setHeader("retry-after", String(err.body.retry_after_seconds));
      } else {
        status = 500;
        body = { error: "internal", message: "Something broke on our side. It is logged." } satisfies ApiErrorBody;
        log.error(`[500] ${method} ${path}:`, err);
      }
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
    res.end(json);
    log.info(`${method} ${path} ${status} ${now() - t0}ms`);
  };
}
