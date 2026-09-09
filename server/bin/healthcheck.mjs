#!/usr/bin/env node
// Hourly, from a systemd timer. Two checks, a Telegram ping on any failure:
//   1. the API answers GET /v1/health
//   2. the SMTP probe reaches Google and gets a definite answer. A random
//      gmail.com mailbox is rejected with 550 5.1.1, and "rejected" proves
//      the whole path (DNS, port 25, EHLO, MAIL FROM, RCPT TO) as well as
//      "accepted" would. Anything else means the tier is degraded.
import { createVerifier } from "mxprobe-core";
import { createNotifier } from "../src/notify.mjs";

const env = process.env;
const notifier = createNotifier(env);
const apiUrl = `http://127.0.0.1:${env.PORT || 8787}`;
const address = env.HEALTH_ADDRESS || "mxprobe-health-check-7f3a@gmail.com";
const failures = [];

try {
  const res = await fetch(`${apiUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) failures.push(`API health ${res.status}`);
} catch (err) {
  failures.push(`API unreachable: ${err.message}`);
}

const v = createVerifier({ smtp: true, autoDisableSmtp: false, helo: env.SMTP_HELO || "probe.mxprobe.dev", from: env.SMTP_FROM || "probe@mxprobe.dev" });
const r = await v.verify(address);
const definite = r.checks.smtp === "accepted" || r.checks.smtp === "rejected";
if (!definite) failures.push(`SMTP probe not definite: ${r.checks.smtp} (${r.reason})`);

if (failures.length) {
  const text = `HEALTH FAIL\n${failures.join("\n")}`;
  console.error(text);
  await notifier.telegram(text);
  process.exit(1);
}
console.log(`health ok: api up, probe ${r.checks.smtp} via ${r.checks.mx}`);
