import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional()
);

function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "redis:" || url.protocol === "rediss:";
  } catch {
    return false;
  }
}

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
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
  PORT: z.coerce.number().int().positive().default(3000),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  REDIS_MODE: z.enum(["redis", "memory"]).default("redis"),
  REDIS_URL: optionalString,
  VIRTUAL_WALLET_START_BALANCE: z.coerce
    .number()
    .positive()
    .default(40),
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

const config = parsed.data;

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

if (config.NODE_ENV === "production") {
  if (config.REDIS_MODE !== "redis") {
    console.error("ERROR: REDIS_MODE must be redis in production. Memory mode is only for local testing.");
    process.exit(1);
  }

  if (config.WEBHOOK_URL && !config.WEBHOOK_SECRET) {
    console.error("ERROR: WEBHOOK_SECRET is required in production when WEBHOOK_URL is set.");
    process.exit(1);
  }

  if (
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
