// The verdict contract, the same in the CLI, the MCP server and the API:
//   { email, action, verdict, reason, checks: { syntax, mx, smtp, catch_all } }
//   action  = send | hold | kill
//   verdict = OK   | WEAK | DEAD
//   `hold` never becomes `kill` on a refusal, a greylist or a catch-all. Only
//   a 5xx that names the mailbox kills.

export type Action = "send" | "hold" | "kill";
export type Verdict = "OK" | "WEAK" | "DEAD";

/** What the SMTP tier said. `skipped` on the DNS tier. */
export type SmtpCheck = "skipped" | "accepted" | "rejected" | "refused" | "deferred" | "unreachable" | "dropped";

export interface Checks {
  syntax: boolean;
  mx: string | null;
  smtp: SmtpCheck;
  catch_all: boolean | null;
}

export interface VerifyResult {
  email: string;
  action: Action;
  verdict: Verdict;
  reason: string;
  checks: Checks;
}

/** Summary counts for a batch. */
export interface Summary {
  send: number;
  hold: number;
  kill: number;
  total: number;
}

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** The part of `node:dns` promises the engine uses. Tests pass a fake. */
export interface Resolver {
  resolveMx(hostname: string): Promise<MxRecord[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}
