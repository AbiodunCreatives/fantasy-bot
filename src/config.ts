import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional()
);

const booleanFlag = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean().default(false));

function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "redis:" || url.protocol === "rediss:";
  } catch {
    return false;
  }
}

const envSchema = z.object({
  DASHBOARD_ONLY_MODE: booleanFlag,
  BOT_TOKEN: optionalString,
  WEBHOOK_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  WEBHOOK_PATH_SECRET: z.preprocess(
    (value) =>
      value === "" || value === undefined
        ? "dev-fantasy-webhook-secret"
        : value,
    z
      .string()
      .min(12, "WEBHOOK_PATH_SECRET must be at least 12 characters")
  ),
  WEBHOOK_SECRET: optionalString,
  HEALTH_CHECK_TOKEN: optionalString,
  ADMIN_DASHBOARD_TOKEN: optionalString,
  ADMIN_USER_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().positive().optional()
  ),
  PAJCASH_ENV: z
    .enum(["staging", "production", "local"])
    .default("production"),
  PAJCASH_API_KEY: optionalString,
  PAJCASH_SESSION_RECIPIENT: optionalString,
  PAJCASH_SESSION_TOKEN: optionalString,
  PAJCASH_SESSION_EXPIRES_AT: optionalString,
  PAJCASH_WEBHOOK_BASE_URL: optionalString,
  PAJCASH_WEBHOOK_PATH_SECRET: optionalString,
  PAJCASH_OTP: optionalString,
  PAJCASH_BUSINESS_USDC_FEE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().nonnegative().optional()
  ),
  PORT: z.coerce.number().int().positive().default(3000),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  REDIS_MODE: z.enum(["redis", "memory"]).optional(),
  REDIS_URL: optionalString,
  VIRTUAL_WALLET_START_BALANCE: z.coerce
    .number()
    .nonnegative()
    .default(0),
  SOLANA_RPC_URL: optionalString,
  SOLANA_USDC_MINT: optionalString,
  SOLANA_TREASURY_SECRET_KEY: optionalString,
  SOLANA_WALLET_ENCRYPTION_KEY: optionalString,
  SOLANA_WALLET_MONITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  SOLANA_WITHDRAW_MIN_AMOUNT: z.coerce
    .number()
    .positive()
    .default(1),
  FANTASY_MONITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  FANTASY_SETTLEMENT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("ERROR: Invalid environment variables:");
  for (const [field, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${errors?.join(", ")}`);
  }
  process.exit(1);
}

function requireString(
  value: string | undefined,
  message: string
): string {
  if (!value || !value.trim()) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }

  return value;
}

const rawConfig = parsed.data;
const dashboardOnlyMode = rawConfig.DASHBOARD_ONLY_MODE;

const config = {
  ...rawConfig,
  BOT_TOKEN: dashboardOnlyMode
    ? rawConfig.BOT_TOKEN?.trim() || "dashboard-only-token"
    : requireString(rawConfig.BOT_TOKEN, "BOT_TOKEN is required"),
  REDIS_MODE: rawConfig.REDIS_MODE ?? (dashboardOnlyMode ? "memory" : "redis"),
  SOLANA_RPC_URL: dashboardOnlyMode
    ? rawConfig.SOLANA_RPC_URL?.trim() || "http://127.0.0.1:8899"
    : requireString(rawConfig.SOLANA_RPC_URL, "SOLANA_RPC_URL is required"),
  SOLANA_USDC_MINT: dashboardOnlyMode
    ? rawConfig.SOLANA_USDC_MINT?.trim() || "11111111111111111111111111111111"
    : requireString(rawConfig.SOLANA_USDC_MINT, "SOLANA_USDC_MINT is required"),
  SOLANA_TREASURY_SECRET_KEY: dashboardOnlyMode
    ? rawConfig.SOLANA_TREASURY_SECRET_KEY?.trim() || "dashboard-only-secret-key"
    : requireString(
        rawConfig.SOLANA_TREASURY_SECRET_KEY,
        "SOLANA_TREASURY_SECRET_KEY is required"
      ),
  SOLANA_WALLET_ENCRYPTION_KEY: dashboardOnlyMode
    ? rawConfig.SOLANA_WALLET_ENCRYPTION_KEY?.trim() ||
      "0000000000000000000000000000000000000000000000000000000000000000"
    : requireString(
        rawConfig.SOLANA_WALLET_ENCRYPTION_KEY,
        "SOLANA_WALLET_ENCRYPTION_KEY is required"
      ),
} as const;

if (config.REDIS_MODE === "redis") {
  if (!config.REDIS_URL) {
    console.error("ERROR: REDIS_URL is required when REDIS_MODE=redis.");
    process.exit(1);
  }

  if (!isRedisUrl(config.REDIS_URL)) {
    console.error(
      "ERROR: REDIS_URL must be a valid redis:// or rediss:// URL when REDIS_MODE=redis."
    );
    process.exit(1);
  }
}

// Fail-closed webhook security: require secrets when webhook URL is configured
if (config.WEBHOOK_URL) {
  if (!config.WEBHOOK_SECRET) {
    console.error("ERROR: WEBHOOK_SECRET is required when WEBHOOK_URL is set.");
    process.exit(1);
  }

  if (config.WEBHOOK_PATH_SECRET === "dev-fantasy-webhook-secret") {
    console.error("ERROR: Set WEBHOOK_PATH_SECRET to a unique value when WEBHOOK_URL is set.");
    process.exit(1);
  }
}

// Require health check token when health endpoint is exposed
if (!config.HEALTH_CHECK_TOKEN) {
  console.error("ERROR: HEALTH_CHECK_TOKEN is required to protect the /health endpoint.");
  process.exit(1);
}

if (config.NODE_ENV === "production") {
  if (!config.DASHBOARD_ONLY_MODE && config.REDIS_MODE !== "redis") {
    console.error("ERROR: REDIS_MODE must be redis in production. Memory mode is only for local testing.");
    process.exit(1);
  }

  if (!config.DASHBOARD_ONLY_MODE && config.WEBHOOK_URL && !config.WEBHOOK_SECRET) {
    console.error("ERROR: WEBHOOK_SECRET is required in production when WEBHOOK_URL is set.");
    process.exit(1);
  }

  if (
    !config.DASHBOARD_ONLY_MODE &&
    config.WEBHOOK_URL &&
    config.WEBHOOK_PATH_SECRET === "dev-fantasy-webhook-secret"
  ) {
    console.error("ERROR: Set WEBHOOK_PATH_SECRET to a unique value in production.");
    process.exit(1);
  }

  if (!config.HEALTH_CHECK_TOKEN) {
    console.error("ERROR: HEALTH_CHECK_TOKEN is required in production to protect /health.");
    process.exit(1);
  }
}

export { config };
export type Config = typeof config;
