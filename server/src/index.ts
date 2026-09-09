// Process entry: env, database, verifier, http server, the 24-hour purge.
import http from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.ts";
import { createNotifier } from "./notify.ts";
import { createProbeVerifier } from "./env.ts";
import { createApp, VERSION } from "./app.ts";

const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || "127.0.0.1";
const DB_PATH = env.DB_PATH || "./data/mxprobe.sqlite";
const RETENTION_HOURS = Number(env.LOG_RETENTION_HOURS || 24);

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = openDb(DB_PATH);
const notifier = createNotifier(env);
const verifier = createProbeVerifier(env);

const app = createApp({
  db,
  verifier,
  notifier,
  config: {
    freeCredits: Number(env.FREE_CREDITS || 100),
    packCredits: Number(env.PACK_CREDITS || 10_000),
    packUsd: Number(env.PACK_USD || 9),
    checksPerMinute: Number(env.CHECKS_PER_MINUTE || 60),
    signupsPerDayPerIp: Number(env.SIGNUPS_PER_DAY_PER_IP || 3),
    siteUrl: env.SITE_URL || "https://mxprobe.dev",
    apiUrl: env.API_URL || "https://api.mxprobe.dev",
    trustProxy: env.TRUST_PROXY === "1",
    stripeSecretKey: env.STRIPE_SECRET_KEY || null,
    stripePriceId: env.STRIPE_PRICE_ID || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
  },
});

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => {
  console.info(`mxprobe-server ${VERSION} on http://${HOST}:${PORT} db=${DB_PATH} telegram=${notifier.configured.telegram} email=${notifier.configured.email} stripe=${!!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID)}`);
});

// The privacy line on the site says 24 hours. Keep it true.
function purge(): void {
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
  try {
    const n = db.purgeLog(cutoff);
    if (n) console.info(`[purge] deleted ${n} verify_log rows older than ${cutoff}`);
  } catch (err) {
    console.error("[purge] failed:", err instanceof Error ? err.message : err);
  }
}
purge();
const purgeTimer = setInterval(purge, 10 * 60 * 1000);

function shutdown(signal: NodeJS.Signals): void {
  console.info(`[${signal}] shutting down`);
  clearInterval(purgeTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
