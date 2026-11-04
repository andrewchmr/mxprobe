// The hosted API client. Also the package's main export, so a Node agent can
// `import { createClient } from "mxprobe"` without the CLI.
import {
  createVerifier,
  summarize,
  type ApiErrorBody,
  type BalanceResponse,
  type CheckoutResponse,
  type SignupResponse,
  type Summary,
  type VerifierOptions,
  type VerifyResponse,
  type VerifyResult,
} from "mxprobe-core";

import { DEFAULT_API_URL } from "./config.ts";

export type { ApiErrorBody, BalanceResponse, CheckoutResponse, SignupResponse, VerifyResponse } from "mxprobe-core";

export class ApiError extends Error {
  readonly status: number;
  readonly body: Partial<ApiErrorBody>;

  constructor(status: number, body: Partial<ApiErrorBody> = {}) {
    super(body.message || body.error || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The part of `fetch` the client uses; tests pass a fake. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ClientOptions {
  apiUrl?: string;
  apiKey?: string | null;
  fetchImpl?: FetchLike;
}

export interface Client {
  signup(email: string): Promise<SignupResponse>;
  verify(emails: readonly string[]): Promise<VerifyResponse>;
  balance(): Promise<BalanceResponse>;
  checkout(packs?: number): Promise<CheckoutResponse>;
}

export function createClient({ apiUrl = DEFAULT_API_URL, apiKey = null, fetchImpl = fetch }: ClientOptions = {}): Client {
  const base = apiUrl.replace(/\/$/, "");

  async function call<T>(method: string, path: string, body?: object, { auth = true } = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "mxprobe-cli" };
    if (auth) {
      if (!apiKey) throw new ApiError(401, { error: "no_api_key", message: "No API key. Run `mxprobe signup you@company.com` or set MXPROBE_API_KEY." });
      headers["authorization"] = `Bearer ${apiKey}`;
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: "bad_response", message: text.slice(0, 200) };
    }
    if (!res.ok) throw new ApiError(res.status, typeof json === "object" && json !== null ? (json as Partial<ApiErrorBody>) : {});
    return json as T;
  }

  return {
    signup: (email) => call<SignupResponse>("POST", "/v1/signup", { email }, { auth: false }),
    verify: (emails) => call<VerifyResponse>("POST", "/v1/verify", { emails }),
    balance: () => call<BalanceResponse>("GET", "/v1/balance"),
    checkout: (packs = 1) => call<CheckoutResponse>("POST", "/v1/credits/checkout", { packs }),
  };
}

export interface CheckOptions {
  /** Send the DNS survivors to the hosted SMTP probe, one credit each. */
  hosted?: boolean;
  /** Needed when `hosted` is on. Only `verify` is called. */
  client?: Pick<Client, "verify"> | null;
  /** Run the SMTP probe locally (needs outbound port 25). */
  smtp?: boolean;
  verifierOptions?: VerifierOptions;
}

/** What a 402 in the middle of a hosted run leaves: the run stops, the results stay. */
export interface OutOfCredits {
  message: string;
  needed: number | null;
  credits_left: number | null;
  /** The key's payment link, for a person to open (null from a server older than 0.2.8). */
  checkout_url: string | null;
  /** Survivors that kept their DNS-tier verdict because no credits were left. */
  not_probed: number;
}

export interface CheckOutput {
  results: VerifyResult[];
  summary: Summary;
  /** How many results came from the hosted tier. */
  hosted: number;
  /** Credits left on the key after the hosted calls, when any were made. */
  credits_left: number | null;
  /** Set when the key ran out of credits before every survivor was probed. */
  out_of_credits: OutOfCredits | null;
}

/** The hosted API takes at most this many addresses per call. */
export const HOSTED_BATCH = 100;

/**
 * The two-tier check the CLI and the MCP server share. The DNS tier runs
 * locally and is free; with `hosted` on, the survivors (send and hold) go to
 * the hosted SMTP probe, one credit each. A DNS kill never costs a credit.
 */
export async function checkEmails(emails: readonly string[], { hosted = false, client = null, smtp = false, verifierOptions = {} }: CheckOptions = {}): Promise<CheckOutput> {
  const local = createVerifier({ ...verifierOptions, smtp });
  const results = await local.verifyBatch(emails);
  let hostedCount = 0;
  let creditsLeft: number | null = null;
  let outOfCredits: OutOfCredits | null = null;
  if (hosted) {
    if (!client) throw new Error("hosted check needs an API client");
    const survivors = results.filter((r) => r.action !== "kill").map((r) => r.email);
    if (survivors.length) {
      const byEmail = new Map<string, VerifyResult>();
      const unsent = new Set<string>();
      for (let i = 0; i < survivors.length; i += HOSTED_BATCH) {
        let res: VerifyResponse;
        try {
          res = await client.verify(survivors.slice(i, i + HOSTED_BATCH));
        } catch (err) {
          // A 402 ends the run, not the results: the chunks already paid for stay.
          if (!(err instanceof ApiError) || err.status !== 402) throw err;
          const rest = survivors.slice(i);
          for (const e of rest) unsent.add(e);
          creditsLeft = err.body.credits_left ?? creditsLeft;
          outOfCredits = { message: err.message, needed: err.body.needed ?? null, credits_left: err.body.credits_left ?? null, checkout_url: err.body.checkout_url ?? null, not_probed: rest.length };
          break;
        }
        for (const r of res.results) byEmail.set(r.email, r);
        creditsLeft = res.credits_left ?? creditsLeft;
      }
      for (const [i, r] of results.entries()) {
        const h = byEmail.get(r.email);
        if (h) {
          results[i] = h;
          hostedCount++;
        } else if (unsent.has(r.email)) {
          results[i] = { ...r, reason: `${r.reason.replace(/; mailbox not probed$/, "")}; mailbox not probed: no credits left` };
        }
      }
    }
  }
  return { results, summary: summarize(results), hosted: hostedCount, credits_left: creditsLeft, out_of_credits: outOfCredits };
}
