// The hosted API's wire types. The server returns them, the `mxprobe` client
// expects them. Types only: nothing here runs.
import type { Summary, VerifyResult } from "./types.ts";

/** Every error response: { error, message } plus route-specific extras. */
export interface ApiErrorBody {
  error: string;
  message: string;
  retry_after_seconds?: number;
  credits_left?: number;
  needed?: number;
  checkout_hint?: string;
  max?: number;
}

export interface SignupResponse {
  api_key: string;
  email: string;
  credits: number;
  mailed: boolean;
  message: string;
}

export interface VerifyResponse {
  results: VerifyResult[];
  summary: Summary;
  credits_used: number;
  credits_left: number;
}

export interface BalanceResponse {
  email: string;
  credits: number;
  checks_total: number;
  created_at: string;
}

export interface CheckoutResponse {
  url: string;
  credits: number;
  amount_usd: number;
  packs: number;
  session_id: string;
  message: string;
}
