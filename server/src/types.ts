/** What the server needs from `console`; tests pass a silent one. */
export interface Logger {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The part of `fetch` the server uses for Stripe, Resend and Telegram; tests pass a fake. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;
