#!/usr/bin/env node
import { main } from "./cli.ts";

// No forced exit on success: the MCP server may still be answering a call
// when stdin closes, and `check` has nothing left to wait for anyway.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
