import { createServer } from "http";

import express from "express";
import { Bot, type Context } from "grammy";

import {
  handleFantasyLeagueUiAction,
  handleFantasyJoinConfirm,
  handleFantasyJoinDecline,
  handleFantasyLeagueTrade,
  handleFantasyTextInput,
  handleLeague,
  handleStart,
} from "./bot/handlers/league.ts";
import { config } from "./config.ts";
import { supabase } from "./db/client.ts";
import { upsertUserProfile } from "./db/users.ts";
import { startFantasyMonitor, stopFantasyMonitor } from "./fantasy-monitor.ts";
import {
  startFantasySettlementMonitor,
  stopFantasySettlementMonitor,
} from "./fantasy-settlement.ts";
import { redis } from "./utils/rateLimit.ts";

const bot = new Bot(config.BOT_TOKEN);
const app = express();

app.use(express.json({ limit: "100kb" }));

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    await upsertUserProfile(ctx.from.id, ctx.from.username).catch((error) => {
      console.warn("[bot] Failed to upsert user profile:", error);
    });
  }

  await next();
});

bot.command("start", wrap(handleStart));
bot.command("league", wrap(handleLeague));
bot.callbackQuery(/^flt:/, wrap(handleFantasyLeagueTrade));
bot.callbackQuery(/^(start|lobby|arena|funds):/, wrap(handleFantasyLeagueUiAction));
bot.callbackQuery("fantasy:join:confirm", wrap(handleFantasyJoinConfirm));
bot.callbackQuery("fantasy:join:decline", wrap(handleFantasyJoinDecline));
bot.on("message:text", async (ctx, next) => {
  const handled = await handleFantasyTextInput(ctx);

  if (handled) {
    return;
  }

  await next();
});

bot.catch((error) => {
  console.error(
    `[bot] Unhandled error for update ${error.ctx.update.update_id}:`,
    error.error
  );

  error.ctx.reply("Something went wrong. Please try again in a moment.").catch(() => null);
});

function wrap(
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => null);
    }

    const updateId = ctx.update.update_id;
    const handlerName = handler.name || "(anonymous)";
    console.log(`[bot] update=${updateId} handler=${handlerName}`);

    try {
      await handler(ctx);
      console.log(`[bot] update=${updateId} handler=${handlerName} - done`);
    } catch (error) {
      console.error(
        `[bot] update=${updateId} handler=${handlerName} - failed:`,
        error
      );
      await ctx.reply("Something went wrong, please try again.").catch(() => null);
    }
  };
}

function normalizeAuthHeader(value: string | undefined): string {
  return (value ?? "").trim();
}

function matchesHealthCheckToken(
  headerValue: string | undefined,
  queryValue: unknown,
  secret: string
): boolean {
  const normalizedHeader = normalizeAuthHeader(headerValue);
  const normalizedQuery =
    typeof queryValue === "string" ? queryValue.trim() : "";

  return (
    normalizedHeader === secret ||
    normalizedHeader === `Bearer ${secret}` ||
    normalizedQuery === secret
  );
}

app.get("/", (_req, res) => {
  res.status(200).send("Bayse fantasy bot is running. Use /health for health checks.");
});

app.get("/health", async (req, res) => {
  if (
    config.HEALTH_CHECK_TOKEN &&
    !matchesHealthCheckToken(
      req.header("x-health-check-token") ?? req.header("authorization"),
      req.query["token"],
      config.HEALTH_CHECK_TOKEN
    )
  ) {
    res.sendStatus(403);
    return;
  }

  const [gamesResult, redisResult] = await Promise.allSettled([
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }),
    redis.dbsize(),
  ]);

  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    fantasy_games:
      gamesResult.status === "fulfilled" ? (gamesResult.value.count ?? 0) : null,
    redis_keys: redisResult.status === "fulfilled" ? redisResult.value : null,
  });
});

app.post("/webhook/:secret", (req, res) => {
  if (req.params["secret"] !== config.WEBHOOK_PATH_SECRET) {
    console.warn("[webhook] Rejected request with invalid path secret");
    res.sendStatus(403);
    return;
  }

  const headerSecret = req.header("x-telegram-bot-api-secret-token");
  if (config.WEBHOOK_SECRET && headerSecret !== config.WEBHOOK_SECRET) {
    console.warn("[webhook] Rejected request with invalid secret token header");
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200);

  bot.handleUpdate(req.body).catch((error) => {
    console.error("[webhook] Unhandled error in handleUpdate:", error);
  });
});

const server = createServer(app);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `[server] Port ${config.PORT} is already in use. Set a different PORT in .env.`
    );
    process.exit(1);
  }

  throw error;
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`[server] ${signal} received. Shutting down gracefully...`);

  stopFantasyMonitor();
  stopFantasySettlementMonitor();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  try {
    await redis.quit();
    console.log("[redis] Connection closed.");
  } catch {
    redis.disconnect();
  }

  bot.stop();
  console.log("[server] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[server] Starting fantasy bot...");

  await redis.ping();
  console.log("[redis] Startup ping OK.");

  await bot.init();
  console.log(`[bot] Initialized as @${bot.botInfo.username}`);

  await bot.api.setMyCommands([
    {
      command: "start",
      description: "Open Bayse Arena and browse arenas",
    },
    {
      command: "league",
      description: "Create, join, and view fantasy arenas",
    },
  ]);

  startFantasyMonitor();
  startFantasySettlementMonitor();

  if (config.WEBHOOK_URL) {
    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.WEBHOOK_PATH_SECRET}`;

    await bot.api.setWebhook(webhookUrl, {
      ...(config.WEBHOOK_SECRET ? { secret_token: config.WEBHOOK_SECRET } : {}),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });

    console.log(`[bot] Webhook registered -> ${webhookUrl}`);

    server.listen(config.PORT, () => {
      console.log(
        `[server] Listening on port ${config.PORT}\n` +
          `[server] Ready:\n` +
          `  POST /webhook/:secret\n` +
          `  GET  /health`
      );
    });

    return;
  }

  console.log("[bot] WEBHOOK_URL not set. Using long polling.");

  await bot.api.deleteWebhook().catch((error) =>
    console.warn("[bot] deleteWebhook failed:", (error as Error).message)
  );

  server.listen(config.PORT, () => {
    console.log(
      `[server] Listening on port ${config.PORT}\n` +
        `[server] Ready:\n` +
        `  GET /health`
    );
  });

  bot
    .start({
      onStart: (info) => {
        console.log(`[bot] Long polling started (@${info.username}).`);
      },
    })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("409")) {
        console.warn(
          "[bot] 409 conflict on startup - another instance was still running."
        );
        process.exit(0);
      }

      console.error("[bot] Fatal polling error:", error);
      process.exit(1);
    });
}

main().catch((error) => {
  console.error("[server] Fatal startup error:", error);
  process.exit(1);
});
