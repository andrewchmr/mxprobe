// Env parsing shared by the entry points (the server and the health probe).
import { createVerifier, type Verifier } from "mxprobe-core";

/** The SMTP-probe verifier built from the environment. */
export function createProbeVerifier(env: NodeJS.ProcessEnv = process.env): Verifier {
  return createVerifier({
    smtp: true,
    autoDisableSmtp: false,
    smtpConcurrency: Number(env.SMTP_CONCURRENCY || 3),
    helo: env.SMTP_HELO || "probe.mxprobe.dev",
    from: env.SMTP_FROM || "probe@mxprobe.dev",
  });
}
