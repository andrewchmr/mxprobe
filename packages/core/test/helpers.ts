// Test doubles: a fake resolver for the DNS tier and a fake SMTP server on
// localhost for the probe. No network.
import net from "node:net";
import type { MxRecord, Resolver } from "../src/index.ts";

export const nx = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

export interface FakeZone {
  /** undefined = ENODATA; missing entry = NXDOMAIN */
  mx?: MxRecord[];
  a?: string[];
  aaaa?: string[];
  ptr?: string;
}

export type FakeTable = Record<string, FakeZone>;

export function fakeResolver(table: FakeTable): Resolver {
  return {
    async resolveMx(domain) {
      const d = table[domain];
      if (!d) throw nx("ENOTFOUND");
      if (d.mx === undefined) throw nx("ENODATA");
      return d.mx;
    },
    async resolve4(host) {
      const d = table[host];
      if (!d || !d.a) throw nx("ENODATA");
      return d.a;
    },
    async resolve6(host) {
      const d = table[host];
      if (!d || !d.aaaa) throw nx("ENODATA");
      return d.aaaa;
    },
    async reverse(ip) {
      const ptr = Object.values(table).find((d) => d.a?.includes(ip))?.ptr;
      if (!ptr) throw nx("ENOTFOUND");
      return [ptr];
    },
  };
}

export const TABLE: FakeTable = {
  "good.test": { mx: [{ exchange: "mx2.good.test", priority: 20 }, { exchange: "mx1.good.test", priority: 10 }] },
  "mx1.good.test": { a: ["127.0.0.1"] },
  "mx2.good.test": { a: ["127.0.0.1"] },
  "nomx.test": { mx: undefined, a: ["75.2.60.5"] },
  "nullmx.test": { mx: [{ exchange: "", priority: 0 }] },
  "parked.test": { mx: [{ exchange: "pixie.porkbun.com", priority: 10 }] },
  "forward.test": { mx: [{ exchange: "eforward1.registrar-servers.com", priority: 10 }] },
  "eforward1.registrar-servers.com": { a: ["127.0.0.1"] },
  "ghostmx.test": { mx: [{ exchange: "mx.ghostmx.test", priority: 10 }] },
  "empty.test": { mx: undefined },
};

/** How the fake mail server answers. Every field has a sane default. */
export interface FakeSmtpOptions {
  /** null: accept the connection and say nothing (a hang). */
  banner?: string | null;
  ehlo?: string;
  helo?: string;
  mailFrom?: string;
  /** Called with the address inside <>; returns the reply line. */
  rcpt?: (addr: string) => string;
  /** Close the socket right after this command instead of answering. */
  dropAfter?: "EHLO" | "MAIL FROM" | "RCPT TO";
}

export interface FakeSmtp {
  port: number;
  /** Every command line received, in order, across all sessions. */
  commands: string[];
  /** The most sessions open at once. */
  maxActive: number;
  close(): void;
}

export const MULTILINE_EHLO = "250-mx1.good.test\r\n250-SIZE 1000\r\n250 8BITMIME\r\n";
export const OK_RCPT = "250 2.1.5 OK\r\n";
export const NO_USER = "550 5.1.1 The email account that you tried to reach does not exist\r\n";

/** Presets: accept alice only, accept anything, greylist, policy block, bad banner. */
export const modes = {
  accept: {},
  catchall: { rcpt: () => OK_RCPT },
  greylist: { rcpt: () => "451 4.7.1 try again later\r\n" },
  blocked: { rcpt: () => "550 5.7.1 our policy rejects your host\r\n" },
  badbanner: { banner: "554 go away\r\n" },
} satisfies Record<string, FakeSmtpOptions>;

export function fakeSmtp(opts: FakeSmtpOptions | keyof typeof modes = {}): Promise<FakeSmtp> {
  const o: FakeSmtpOptions = typeof opts === "string" ? modes[opts] : opts;
  const banner = o.banner === undefined ? "220 mx1.good.test ESMTP fake\r\n" : o.banner;
  const ehlo = o.ehlo ?? MULTILINE_EHLO;
  const helo = o.helo ?? "250 mx1.good.test\r\n";
  const mailFrom = o.mailFrom ?? "250 2.1.0 OK\r\n";
  const rcpt = o.rcpt ?? ((addr: string) => (addr === "alice@good.test" ? OK_RCPT : NO_USER));
  const state = { commands: [] as string[], active: 0, maxActive: 0 };

  const server = net.createServer((sock) => {
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    sock.on("close", () => state.active--);
    if (banner === null) return;
    if (!banner.startsWith("220")) return void sock.end(banner);
    sock.write(banner);
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        state.commands.push(line);
        const cmd = line.toUpperCase();
        const verb = cmd.startsWith("EHLO") ? "EHLO" : cmd.startsWith("MAIL FROM") ? "MAIL FROM" : cmd.startsWith("RCPT TO") ? "RCPT TO" : null;
        if (verb && o.dropAfter === verb) return void sock.destroy();
        if (verb === "EHLO") sock.write(ehlo);
        else if (cmd.startsWith("HELO")) sock.write(helo);
        else if (verb === "MAIL FROM") sock.write(mailFrom);
        else if (verb === "RCPT TO") sock.write(rcpt(line.match(/<([^>]+)>/)?.[1] ?? ""));
        else if (cmd.startsWith("QUIT")) sock.end("221 bye\r\n");
        else sock.write("500 unknown\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({
        port: addr.port,
        commands: state.commands,
        get maxActive() {
          return state.maxActive;
        },
        close: () => server.close(),
      });
    });
  });
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const s = await fakeSmtp();
  s.close();
  await new Promise((r) => setTimeout(r, 20));
  return s.port;
}
