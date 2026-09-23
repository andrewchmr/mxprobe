// Tier 2: the SMTP probe. Connects to the MX on port 25, says EHLO and MAIL
// FROM, asks RCPT TO for the address and for a random local part (the
// catch-all test), then QUITs. No message is ever sent. Needs outbound port 25.
import net from "node:net";
import { randomBytes } from "node:crypto";
import { resolveOptions, type VerifierOptions } from "./options.ts";
import type { SmtpCheck, Verdict } from "./types.ts";
import { errorCode, errorMessage, withTimeout } from "./util.ts";

// Reply text that means "this mailbox does not exist", as opposed to "we do
// not like you" (5.7.x) or "not now" (4xx).
const NO_SUCH_MAILBOX =
  /5\.1\.[0136]\b|5\.4\.1\b|user unknown|unknown user|does not exist|doesn't exist|no such (user|recipient|mailbox)|not found|not exist|no mailbox|invalid recipient|recipient rejected|recipient address rejected|unrouteable|unknown recipient|not our customer|mailbox unavailable|address rejected|invalid mailbox|unknown address/i;

// Reply text that means "this mailbox exists but is switched off" (RFC 3463
// X.2.1, Google's "550-5.2.1 The email account that you tried to reach is
// inactive/disabled"). It bounces like a missing mailbox, so it kills too. The
// status code alone is not enough: Google also sends 5.2.1 for a mailbox that
// is receiving mail too fast, which says nothing about whether it exists.
const DISABLED_MAILBOX =
  /\b5\.2\.1\b.{0,200}?\b(inactive|disabled)\b|(mailbox|account) (is )?(disabled|inactive|suspended)|disabled (mailbox|account)/i;

/** Connect errors that mean the network blocks port 25, not that one MX is down. */
export const PORT_BLOCKED: ReadonlySet<string> = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

export type ProbeSmtp = Exclude<SmtpCheck, "skipped">;

export interface ProbeResult {
  verdict: Verdict;
  reason: string;
  smtp: ProbeSmtp;
  catchAll: boolean | null;
  /** The connect error code when smtp is `unreachable`. */
  connectError?: string;
}

export interface ProbeOptions extends VerifierOptions {
  /** Connect to this address (the resolved MX IP) while naming mxHost in the reason. */
  connectHost?: string;
}

interface Reply {
  code: number;
  /** All lines of a multi-line reply, joined with " | ". */
  text: string;
}

interface SmtpSession {
  read(): Promise<Reply>;
  send(cmd: string): Promise<Reply>;
  close(): void;
}

interface Waiter {
  resolve(reply: Reply): void;
  reject(err: Error): void;
}

const codedError = (message: string, code: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

// A line-oriented SMTP client: connect, then read() a reply or send(cmd) and
// read its reply. Multi-line replies (250-... 250 ...) come back as one.
function connectSmtp(host: string, port: number, timeoutMs: number): Promise<SmtpSession> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let buffer = "";
    let lines: string[] = [];
    const queued: Reply[] = [];
    let waiter: Waiter | null = null;
    let dead: Error | null = null;
    let connected = false;

    const fail = (err: Error): void => {
      dead = dead ?? err;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(err);
      }
      if (!connected) reject(err);
      socket.destroy();
    };
    socket.on("timeout", () => fail(codedError("SMTP timeout", "ETIMEDOUT")));
    socket.on("error", fail);
    socket.on("close", () => fail(codedError("connection closed", "ECLOSED")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        lines.push(line);
        if (/^\d{3}( |$)/.test(line)) {
          const reply: Reply = { code: Number(line.slice(0, 3)), text: lines.join(" | ") };
          lines = [];
          if (waiter) {
            const w = waiter;
            waiter = null;
            w.resolve(reply);
          } else {
            queued.push(reply);
          }
        }
      }
    });
    const read = (): Promise<Reply> =>
      new Promise((res, rej) => {
        const next = queued.shift();
        if (next) return res(next);
        if (dead) return rej(dead);
        waiter = { resolve: res, reject: rej };
      });
    const send = (cmd: string): Promise<Reply> => {
      if (dead) return Promise.reject(dead);
      socket.write(`${cmd}\r\n`);
      return read();
    };
    socket.once("connect", () => {
      connected = true;
      resolve({ read, send, close: () => socket.destroy() });
    });
  });
}

const firstLine = (reply: Reply): string => reply.text.split(" | ")[0] ?? "";
const refused = (reason: string): ProbeResult => ({ verdict: "WEAK", reason, smtp: "refused", catchAll: null });
const deferred = (reason: string): ProbeResult => ({ verdict: "WEAK", reason, smtp: "deferred", catchAll: null });

/**
 * Probe one mailbox on one MX. `smtp` is accepted | rejected | refused |
 * deferred | unreachable | dropped. Never sends DATA.
 */
export async function probeMailbox(email: string, domain: string, mxHost: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const o = resolveOptions(opts);
  const target = o.hostOverride ?? opts.connectHost ?? mxHost;
  let s: SmtpSession;
  try {
    s = await withTimeout(connectSmtp(target, o.port, o.smtpTimeoutMs), "connect", o.smtpTimeoutMs);
  } catch (err) {
    const code = errorCode(err) ?? "EUNKNOWN";
    return { verdict: "WEAK", reason: `cannot connect to ${mxHost}:${o.port} (${code})`, smtp: "unreachable", catchAll: null, connectError: code };
  }
  try {
    const banner = await s.read();
    if (banner.code !== 220) return refused(`${mxHost} greeted with ${firstLine(banner)}`);
    let r = await s.send(`EHLO ${o.helo}`);
    if (r.code !== 250) {
      r = await s.send(`HELO ${o.helo}`);
      if (r.code !== 250) return refused(`${mxHost} refused HELO (${firstLine(r)})`);
    }
    r = await s.send(`MAIL FROM:<${o.from}>`);
    if (r.code !== 250) {
      return r.code >= 500 ? refused(`${mxHost} refused the sender (${firstLine(r)})`) : deferred(`${mxHost} deferred the sender (${firstLine(r)})`);
    }
    r = await s.send(`RCPT TO:<${email}>`);
    let result: ProbeResult;
    if (r.code === 250 || r.code === 251) {
      const random = `${randomBytes(6).toString("hex")}-probe@${domain}`;
      const c = await s.send(`RCPT TO:<${random}>`);
      result =
        c.code === 250 || c.code === 251
          ? { verdict: "WEAK", reason: `${domain} is catch-all: ${mxHost} accepts any local part, so the mailbox cannot be proven`, smtp: "accepted", catchAll: true }
          : { verdict: "OK", reason: `mailbox accepted by ${mxHost}`, smtp: "accepted", catchAll: false };
    } else if (r.code >= 500 && DISABLED_MAILBOX.test(r.text)) {
      result = { verdict: "DEAD", reason: `${mxHost} says the mailbox is disabled (${firstLine(r)})`, smtp: "rejected", catchAll: null };
    } else if (r.code >= 500 && NO_SUCH_MAILBOX.test(r.text)) {
      result = { verdict: "DEAD", reason: `${mxHost} says the mailbox does not exist (${firstLine(r)})`, smtp: "rejected", catchAll: null };
    } else if (r.code >= 500) {
      result = refused(`${mxHost} refused the probe, not the mailbox (${firstLine(r)})`);
    } else {
      result = deferred(`${mxHost} deferred (${firstLine(r)})`);
    }
    await s.send("QUIT").catch(() => {});
    return result;
  } catch (err) {
    return { verdict: "WEAK", reason: `${mxHost} dropped the session (${errorCode(err) ?? errorMessage(err)})`, smtp: "dropped", catchAll: null };
  } finally {
    s.close();
  }
}
