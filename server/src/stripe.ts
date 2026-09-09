// Stripe with no SDK: one Checkout Session create over REST, and the webhook
// signature check (HMAC-SHA256 over "<t>.<raw body>" with the endpoint secret).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FetchLike } from "./types.ts";

const STRIPE_API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  readonly status: number;
  readonly stripe: unknown;

  constructor(message: string, status: number, stripe: unknown) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.stripe = stripe;
  }
}

export interface CheckoutParams {
  secretKey: string;
  priceId: string;
  /** Packs of credits; the price is per pack. */
  quantity: number;
  keyId: number;
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
  description: string;
  fetchImpl?: FetchLike;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

interface StripeSessionBody {
  id?: unknown;
  url?: unknown;
  error?: { message?: unknown };
}

export async function createCheckoutSession({ secretKey, priceId, quantity, keyId, email, successUrl, cancelUrl, description, fetchImpl = fetch }: CheckoutParams): Promise<CheckoutSession> {
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": String(quantity),
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(keyId),
    "metadata[key_id]": String(keyId),
    "metadata[packs]": String(quantity),
    "payment_intent_data[description]": description,
    // The account is CMS Brew's, so the card line reads "CMSBREW* MXPROBE".
    "payment_intent_data[statement_descriptor_suffix]": "MXPROBE",
    // Pinned on purpose: automatic payment methods reject a USD session on a
    // non-US account (local methods are EUR/PLN only).
    "payment_method_types[0]": "card",
    allow_promotion_codes: "true",
  });
  if (email) form.set("customer_email", email);
  const res = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as StripeSessionBody;
  if (!res.ok) {
    const msg = typeof body.error?.message === "string" ? body.error.message : `Stripe HTTP ${res.status}`;
    throw new StripeError(msg, res.status, body.error);
  }
  if (typeof body.id !== "string" || typeof body.url !== "string") throw new StripeError("Stripe returned a session without id or url", res.status, body);
  return { id: body.id, url: body.url };
}

export interface SignatureHeader {
  t: number | null;
  signatures: string[];
}

/** Parse "t=...,v1=...,v1=..." into { t, signatures }. */
export function parseSignatureHeader(header: unknown): SignatureHeader {
  const out: SignatureHeader = { t: null, signatures: [] };
  for (const part of String(header ?? "").split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t") out.t = Number(v);
    else if (k === "v1" && v) out.signatures.push(v);
  }
  return out;
}

export interface VerifyOptions {
  toleranceSec?: number;
  nowSec?: number;
}

/** True when the header signs this exact raw body with this secret, within the tolerance. */
export function verifyStripeSignature(rawBody: string, header: unknown, secret: string, { toleranceSec = 300, nowSec = Date.now() / 1000 }: VerifyOptions = {}): boolean {
  const { t, signatures } = parseSignatureHeader(header);
  if (!t || !Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const eb = Buffer.from(expected, "utf8");
  return signatures.some((sig) => {
    const sb = Buffer.from(sig, "utf8");
    return sb.length === eb.length && timingSafeEqual(sb, eb);
  });
}

/** Build a signature header, for tests and for the local smoke script. */
export function signPayload(rawBody: string, secret: string, tSec: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${tSec}.${rawBody}`).digest("hex");
  return `t=${tSec},v1=${v1}`;
}
