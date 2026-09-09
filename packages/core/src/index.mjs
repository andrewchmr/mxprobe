// MX Probe engine. Zero dependencies, Node 20+.
//
// Two tiers, run in order:
//   1. DNS. Free and local. Finds domains that cannot receive mail: no MX and
//      a web host behind the A record, a null MX, an MX that does not resolve,
//      a domain that does not exist, a parking host as MX.
//   2. SMTP probe. Connects to the MX on port 25, says EHLO and MAIL FROM,
//      asks RCPT TO for the address and for a random local part (the catch-all
//      test), then QUITs. No message is ever sent. Needs outbound port 25.
//
// The verdict contract, the same in the CLI, the MCP server and the API:
//   { email, action, verdict, reason, checks: { syntax, mx, smtp, catch_all } }
//   action  = send | hold | kill
//   verdict = OK   | WEAK | DEAD
//   `hold` never becomes `kill` on a refusal, a greylist or a catch-all. Only
//   a 5xx that names the mailbox kills.

import { promises as dnsPromises } from "node:dns";
import net from "node:net";
import { randomBytes } from "node:crypto";

export const VERSION = "0.1.0";
export const ACTIONS = Object.freeze({ OK: "send", WEAK: "hold", DEAD: "kill" });
export const VERDICTS = Object.freeze(["OK", "WEAK", "DEAD"]);

export const DEFAULTS = Object.freeze({
  smtp: false,
  dnsTimeoutMs: 8000,
  smtpTimeoutMs: 12000,
  smtpConcurrency: 3,
  dnsConcurrency: 20,
  helo: "probe.mxprobe.dev",
  from: "probe@mxprobe.dev",
  port: 25,
  hostOverride: null,
  // When true, an ECONNREFUSED / EHOSTUNREACH / ENETUNREACH on a probe turns
  // the SMTP tier off for the rest of the run: the network blocks port 25.
  // The hosted API sets this to false because its port is proven by a health
  // check, and one refusing MX must not switch the tier off for everyone.
  autoDisableSmtp: true,
  resolver: dnsPromises,
});

// MX hosts that forward rather than hold mail. They bounce when the forward
// target is dead, and some refuse relays outright.
const FORWARDER_MX = [
  /registrar-servers\.com$/i, // Namecheap eforward1..5
  /improvmx\.com$/i,
  /forwardemail\.net$/i,
  /mx\.cloudflare\.net$/i, // Cloudflare Email Routing route1..3
  /fwd\d*\.porkbun\.com$/i,
  /mailforward\./i,
  /forwardmx\./i,
];

// Hosts that serve web pages, not mail. An MX pointing here times out.
const WEBHOST_MX = [
  /pixie\.porkbun\.com$/i,
  /parkingcrew\./i,
  /sedoparking\./i,
  /bodis\./i,
  /above\.com$/i,
];

// Reply text that means "this mailbox does not exist", as opposed to "we do
// not like you" (5.7.x) or "not now" (4xx).
const NO_SUCH_MAILBOX =
  /5\.1\.[0136]\b|5\.4\.1\b|user unknown|unknown user|does not exist|doesn't exist|no such (user|recipient|mailbox)|not found|not exist|no mailbox|invalid recipient|recipient rejected|recipient address rejected|unrouteable|unknown recipient|not our customer|mailbox unavailable|address rejected|invalid mailbox|unknown address/i;

const PORT_BLOCKED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

const isNullMx = (mx) => mx.length === 1 && mx[0].exchange === "" && mx[0].priority === 0;

function withTimeout(promise, label, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function lookupAny(resolver, host) {
  const [a, aaaa] = await Promise.all([
    resolver.resolve4(host).catch(() => []),
    resolver.resolve6(host).catch(() => []),
  ]);
  return { v4: a, v6: aaaa, all: [...a, ...aaaa] };
}

async function reverseName(resolver, ip, ms) {
  try {
    const names = await withTimeout(resolver.reverse(ip), "reverse", ms);
    return names[0] ?? null;
  } catch {
    return null;
  }
}

export function labelWebHost(ip, ptr) {
  const p = (ptr ?? "").toLowerCase();
  if (ip === "75.2.60.5" || ip === "99.83.190.102" || p.includes("netlify")) return "Netlify";
  if (ip.startsWith("76.76.21.") || ip.startsWith("216.198.79.") || p.includes("vercel")) return "Vercel";
  if (ip.startsWith("104.21.") || ip.startsWith("172.67.") || ip.startsWith("188.114.9") || p.includes("cloudflare")) return "Cloudflare";
  if (p.includes("amazonaws") || p.includes("awsglobalaccelerator")) return "AWS";
  if (p.includes("github")) return "GitHub Pages";
  if (p.includes("squarespace") || p.includes("wixdns") || p.includes("webflow")) return "site builder";
  return ptr ?? "unknown host";
}

/** Split an address into local part and domain, or return { error }. */
export function parseAddress(raw) {
  const email = String(raw ?? "").trim();
  const m = email.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!m) return { email, error: "not an email address" };
  const local = m[1];
  const domain = m[2].toLowerCase().replace(/\.$/, "");
  if (local.length > 64 || domain.length > 253 || /\.\./.test(domain) || /[^a-z0-9.-]/.test(domain)) {
    return { email, error: "malformed address" };
  }
  return { email: `${local}@${domain}`, local, domain };
}

// ---------------------------------------------------------------- tier 1: DNS

/**
 * The DNS tier for one domain. Returns { verdict, reason, mx, mxHosts } where
 * mx is the primary MX host name (null when the domain is DEAD) and mxHosts is
 * the sorted list of { host, ip } to try in order.
 */
export async function checkDomain(domain, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { resolver } = o;
  let mx;
  try {
    mx = await withTimeout(resolver.resolveMx(domain), "MX", o.dnsTimeoutMs);
  } catch (err) {
    const code = err?.code ?? "";
    if (code === "ENOTFOUND") return dead("domain does not exist (NXDOMAIN)");
    if (code !== "ENODATA" && !/timed out/.test(err.message)) return dead(`MX lookup failed (${code || err.message})`);
    mx = [];
  }

  if (mx.length === 0) {
    const ips = await withTimeout(lookupAny(resolver, domain), "A/AAAA", o.dnsTimeoutMs);
    if (ips.all.length === 0) return dead("no MX and no A/AAAA record");
    const ip = ips.all[0];
    const host = labelWebHost(ip, await reverseName(resolver, ip, o.dnsTimeoutMs));
    return dead(`no MX record; mail falls back to the A record ${ip} (${host}), which does not take mail`);
  }

  if (isNullMx(mx)) return dead("null MX (RFC 7505): the domain accepts no mail");

  const sorted = [...mx].sort((x, y) => x.priority - y.priority).map((r) => r.exchange.replace(/\.$/, "").toLowerCase());
  const primary = sorted[0];

  if (WEBHOST_MX.some((re) => re.test(primary))) return dead(`MX ${primary} is a web or parking host, not a mail server`);

  const primaryIps = await withTimeout(lookupAny(resolver, primary), "MX host", o.dnsTimeoutMs);
  if (primaryIps.all.length === 0) return dead(`MX host ${primary} does not resolve`);

  const mxHosts = [{ host: primary, ip: primaryIps.v4[0] ?? primaryIps.v6[0] }];
  if (sorted[1] && sorted[1] !== primary) mxHosts.push({ host: sorted[1], ip: null });

  if (FORWARDER_MX.some((re) => re.test(primary))) {
    return { verdict: "WEAK", reason: `MX ${primary} is a forwarder; it bounces when the forward target is dead`, mx: primary, mxHosts };
  }
  return { verdict: "OK", reason: `MX ${primary}`, mx: primary, mxHosts };

  function dead(reason) {
    return { verdict: "DEAD", reason, mx: null, mxHosts: [] };
  }
}

// --------------------------------------------------------- tier 2: SMTP probe

// A line-oriented SMTP client: connect, then read() a reply or send(cmd) and
// read its reply. Multi-line replies (250-... 250 ...) come back as one.
function connectSmtp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    let buffer = "";
    let lines = [];
    const queued = [];
    let waiter = null;
    let dead = null;
    let connected = false;

    const fail = (err) => {
      dead = dead ?? err;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(err);
      }
      if (!connected) reject(err);
      socket.destroy();
    };
    socket.on("timeout", () => fail(Object.assign(new Error("SMTP timeout"), { code: "ETIMEDOUT" })));
    socket.on("error", fail);
    socket.on("close", () => fail(Object.assign(new Error("connection closed"), { code: "ECLOSED" })));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        lines.push(line);
        if (/^\d{3}( |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: lines.join(" | ") };
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
    const read = () =>
      new Promise((res, rej) => {
        if (queued.length) return res(queued.shift());
        if (dead) return rej(dead);
        waiter = { resolve: res, reject: rej };
      });
    const send = (cmd) => {
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

const firstLine = (reply) => reply.text.split(" | ")[0];

/**
 * Probe one mailbox on one MX. Returns { verdict, reason, smtp, catchAll,
 * connectError }. smtp is one of accepted | rejected | refused | deferred |
 * unreachable | dropped. Never sends DATA.
 */
export async function probeMailbox(email, domain, mxHost, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const target = o.hostOverride ?? o.connectHost ?? mxHost;
  let s;
  try {
    s = await withTimeout(connectSmtp(target, o.port, o.smtpTimeoutMs), "connect", o.smtpTimeoutMs);
  } catch (err) {
    const code = err.code ?? "EUNKNOWN";
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
    if (r.code !== 250) return r.code >= 500 ? refused(`${mxHost} refused the sender (${firstLine(r)})`) : deferred(`${mxHost} deferred the sender (${firstLine(r)})`);
    r = await s.send(`RCPT TO:<${email}>`);
    let result;
    if (r.code === 250 || r.code === 251) {
      const random = `${randomBytes(6).toString("hex")}-probe@${domain}`;
      const c = await s.send(`RCPT TO:<${random}>`);
      result =
        c.code === 250 || c.code === 251
          ? { verdict: "WEAK", reason: `${mxHost} is catch-all, it accepts any local part`, smtp: "accepted", catchAll: true }
          : { verdict: "OK", reason: `mailbox accepted by ${mxHost}`, smtp: "accepted", catchAll: false };
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
    return { verdict: "WEAK", reason: `${mxHost} dropped the session (${err.code ?? err.message})`, smtp: "dropped", catchAll: null };
  } finally {
    s.close();
  }

  function refused(reason) {
    return { verdict: "WEAK", reason, smtp: "refused", catchAll: null };
  }
  function deferred(reason) {
    return { verdict: "WEAK", reason, smtp: "deferred", catchAll: null };
  }
}

// ------------------------------------------------------------------- driver

const RANK = { OK: 0, WEAK: 1, DEAD: 2 };

function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { fn, res, rej } = queue.shift();
    fn()
      .then(res, rej)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      queue.push({ fn, res, rej });
      next();
    });
}

function result(email, verdict, reason, checks) {
  return {
    email,
    action: ACTIONS[verdict],
    verdict,
    reason,
    checks: { syntax: true, mx: null, smtp: "skipped", catch_all: null, ...checks },
  };
}

/**
 * A verifier with shared limits. The hosted API keeps one for its lifetime so
 * the SMTP concurrency cap holds across requests; the CLI makes one per run.
 */
export function createVerifier(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const state = { smtpDown: false, smtpDownWhy: null };
  const dnsLimit = makeSemaphore(o.dnsConcurrency);
  const smtpLimit = makeSemaphore(o.smtpConcurrency);

  async function verify(raw) {
    const parsed = parseAddress(raw);
    if (parsed.error) return result(parsed.email, "DEAD", parsed.error, { syntax: false });
    const { email, domain } = parsed;
    try {
      const d = await dnsLimit(() => checkDomain(domain, o));
      if (d.verdict === "DEAD") return result(email, "DEAD", d.reason, { mx: null });

      if (!o.smtp) {
        const note = d.verdict === "OK" ? "; mailbox not probed" : "";
        return result(email, d.verdict, `${d.reason}${note}`, { mx: d.mx });
      }
      if (state.smtpDown) {
        return result(email, d.verdict, `${d.reason}; SMTP tier off for this run (${state.smtpDownWhy})`, { mx: d.mx, smtp: "unreachable" });
      }

      const probe = await smtpLimit(() => probeWithFallback(email, domain, d.mxHosts, o));
      if (probe.connectError && o.autoDisableSmtp && PORT_BLOCKED.has(probe.connectError)) {
        state.smtpDown = true;
        state.smtpDownWhy = `${probe.connectError} on ${d.mx}:${o.port}`;
        return result(email, d.verdict, `${d.reason}; SMTP tier off for this run (${probe.connectError})`, { mx: d.mx, smtp: "unreachable" });
      }
      const verdict = RANK[probe.verdict] >= RANK[d.verdict] ? probe.verdict : d.verdict;
      const reason = d.verdict === "WEAK" && probe.verdict === "OK" ? `${probe.reason}; ${d.reason}` : probe.reason;
      return result(email, verdict, reason, { mx: d.mx, smtp: probe.smtp, catch_all: probe.catchAll });
    } catch (err) {
      return result(email, "WEAK", `check did not finish (${err.message})`, {});
    }
  }

  async function verifyBatch(emails) {
    return Promise.all(emails.map((e) => verify(e)));
  }

  return { verify, verifyBatch, state, options: o };
}

// Try the primary MX, then the secondary when the primary cannot be reached at all.
async function probeWithFallback(email, domain, mxHosts, o) {
  let last = null;
  for (const { host, ip } of mxHosts) {
    const probe = await probeMailbox(email, domain, host, { ...o, connectHost: ip ?? host });
    if (probe.smtp !== "unreachable") return probe;
    last = probe;
    if (PORT_BLOCKED.has(probe.connectError)) return probe;
  }
  return last;
}

/** One-shot helpers. Each call gets its own limits. */
export function verify(email, opts = {}) {
  return createVerifier(opts).verify(email);
}

export function verifyBatch(emails, opts = {}) {
  return createVerifier(opts).verifyBatch(emails);
}

/** Summary counts for a batch: { send, hold, kill, total }. */
export function summarize(results) {
  const s = { send: 0, hold: 0, kill: 0, total: results.length };
  for (const r of results) s[r.action]++;
  return s;
}
