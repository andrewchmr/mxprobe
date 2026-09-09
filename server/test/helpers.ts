// Test doubles for the server: a fake resolver, a canned verifier, a
// notifier that records what it sent, a fake Stripe, and boot(), which runs
// the app on a real node:http server with an in-memory database.
import http from "node:http";
import { ACTIONS, parseAddress, type Resolver, type Verdict, type Verifier, type VerifyResult } from "mxprobe-core";
import { openDb, type Db } from "../src/db.ts";
import { createApp, type AppConfig, type AppDeps } from "../src/app.ts";
import type { Mail, Notifier } from "../src/notify.ts";
import type { FetchLike, FetchResponseLike, Logger } from "../src/types.ts";

const nx = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** dead.test is NXDOMAIN; every other domain has mx.good.test. */
export const resolver: Resolver = {
  async resolveMx(d) {
    if (d === "dead.test") throw nx("ENOTFOUND");
    return [{ exchange: "mx.good.test", priority: 10 }];
  },
  async resolve4(h) {
    if (h === "mx.good.test") return ["192.0.2.1"];
    throw nx("ENODATA");
  },
  async resolve6() {
    throw nx("ENODATA");
  },
  async reverse() {
    throw nx("ENOTFOUND");
  },
};

export const canned = (email: string, verdict: Verdict = "OK", extra: Partial<VerifyResult["checks"]> = {}): VerifyResult => ({
  email,
  action: ACTIONS[verdict],
  verdict,
  reason: `canned ${verdict}`,
  checks: { syntax: true, mx: "mx.good.test", smtp: "accepted", catch_all: false, ...extra },
});

const syntaxKill = (email: string, error: string): VerifyResult => ({ email, action: "kill", verdict: "DEAD", reason: error, checks: { syntax: false, mx: null, smtp: "skipped", catch_all: null } });

/** Syntax kills are real; every other address gets its canned verdict, default OK. */
export const fakeVerifier = (map: Record<string, VerifyResult> = {}): Pick<Verifier, "verifyBatch"> => ({
  verifyBatch: async (emails) =>
    emails.map((e) => {
      const p = parseAddress(e);
      return p.error !== undefined ? syntaxKill(e, p.error) : (map[e] ?? canned(e));
    }),
});

export interface FakeNotifier extends Notifier {
  sent: { emails: Mail[]; telegrams: string[] };
}

export function fakeNotifier(): FakeNotifier {
  const sent = { emails: [] as Mail[], telegrams: [] as string[] };
  return {
    configured: { telegram: true, email: true },
    sent,
    email: async (m) => (sent.emails.push(m), true),
    telegram: async (t) => (sent.telegrams.push(t), true),
  };
}

export const jsonResponse = (status: number, body: unknown): FetchResponseLike => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

export interface StripeCall {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

export function fakeStripeFetch(reply: FetchResponseLike = jsonResponse(200, { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" })) {
  const calls: StripeCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: new URLSearchParams(init.body) });
    return reply;
  };
  return { fetchImpl, calls };
}

export const quiet: Logger = { info() {}, error() {} };

export interface ApiReply {
  status: number;
  headers: Headers;
  /** Parsed JSON; tests reach into it freely. */
  body: any;
}

export interface Booted {
  db: Db;
  notifier: FakeNotifier;
  stripe: ReturnType<typeof fakeStripeFetch>;
  base: string;
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiReply>;
  bearer(key: string): Record<string, string>;
  /** Sign up and return the bearer headers for the new key. */
  signup(email?: string): Promise<{ key: string; headers: Record<string, string>; id: number }>;
  close(): Promise<void>;
}

export interface BootDeps extends Partial<Pick<AppDeps, "verifier" | "now">> {
  /** What the fake Stripe answers; default a created session. */
  stripeReply?: FetchResponseLike;
}

export async function boot(config: Partial<AppConfig> = {}, deps: BootDeps = {}): Promise<Booted> {
  const db = openDb(":memory:");
  const notifier = fakeNotifier();
  const stripe = fakeStripeFetch(deps.stripeReply);
  const app = createApp({
    db,
    verifier: deps.verifier ?? fakeVerifier(),
    notifier,
    fetchImpl: stripe.fetchImpl,
    log: quiet,
    now: deps.now,
    config: { resolver, signupsPerDayPerIp: 10, stripeSecretKey: "sk_test_x", stripePriceId: "price_x", stripeWebhookSecret: "whsec_test", ...config },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${addr.port}`;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiReply> => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const signup = async (email = "ops@good.test") => {
    const r = await api("POST", "/v1/signup", { email });
    if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
    const row = db.keyByEmail(email.toLowerCase());
    if (!row) throw new Error("no row after signup");
    return { key: r.body.api_key as string, headers: bearer(r.body.api_key), id: row.id };
  };
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { db, notifier, stripe, api, bearer, signup, close, base };
}
