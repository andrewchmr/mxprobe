// The package's Node API: the hosted client and the two-tier check.
export { ApiError, HOSTED_BATCH, checkEmails, createClient } from "./client.ts";
export type { ApiErrorBody, BalanceResponse, CheckOptions, CheckOutput, CheckoutResponse, Client, ClientOptions, FetchLike, SignupResponse, VerifyResponse } from "./client.ts";
export { DEFAULT_API_URL, configPath, readConfig, writeConfig } from "./config.ts";
export type { Config, ConfigFile } from "./config.ts";
