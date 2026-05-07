import { createServer } from "http";

import express from "express";
import { Bot, type Context } from "grammy";

import { registerAdminDashboard } from "./admin-dashboard.ts";
import { getBtcChartMenuUrl, registerBtcChartMenuPage } from "./btc-chart-menu.ts";
import {
  handleBoard,
  handleChart,
  handleCreate,
  handleFundNgn,
  handleFantasyLeagueUiAction,
  handleFantasyJoinConfirm,
  handleFantasyJoinDecline,
  handleFantasyLeagueTrade,
  handleFantasyTextInput,
  handleHelp,
  handleJoin,
  handleLeague,
  handleLive,
  handleStart,
  handleStatus,
  handleWithdraw,
  handleWallet,
} from "./bot/handlers/league.ts";
import { config } from "./config.ts";
import { supabase } from "./db/client.ts";
import { upsertUserProfile } from "./db/users.ts";
import { startFantasyMonitor, stopFantasyMonitor } from "./fantasy-monitor.ts";
import { createRateLimitMiddleware } from "./http-security.ts";
import { reconcilePajCashWebhook } from "./pajcash.ts";
import {
  startFantasySettlementMonitor,
  stopFantasySettlementMonitor,
} from "./fantasy-settlement.ts";
import {
  startSolanaWalletMonitor,
  stopSolanaWalletMonitor,
} from "./solana-wallet-monitor.ts";
import { redis } from "./utils/rateLimit.ts";

const bot = new Bot(config.BOT_TOKEN);
const app = express();
const healthRateLimit = createRateLimitMiddleware({
  keyPrefix: "health-route",
  limit: 30,
  windowSeconds: 60,
  message: "Too many health checks. Please wait a minute.",
});
const pajcashWebhookRateLimit = createRateLimitMiddleware({
  keyPrefix: "pajcash-webhook",
  limit: 60,
  windowSeconds: 60,
  message: "Too many PajCash webhook requests. Please wait a minute.",
});
const telegramWebhookRateLimit = createRateLimitMiddleware({
  keyPrefix: "telegram-webhook",
  limit: 180,
  windowSeconds: 60,
  message: "Too many Telegram webhook requests. Please wait a minute.",
});

app.set("trust proxy", true);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
registerAdminDashboard(app);
registerBtcChartMenuPage(app);

bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    await upsertUserProfile(ctx.from.id, ctx.from.username).catch((error) => {
      console.warn("[bot] Failed to upsert user profile:", error);
    });
  }

  await next();
});

bot.command("start", wrap(handleStart));
bot.command("help", wrap(handleHelp));
bot.command("chart", wrap(handleChart));
bot.command("league", wrap(handleLeague));
bot.command("create", wrap(handleCreate));
bot.command("join", wrap(handleJoin));
bot.command("live", wrap(handleLive));
bot.command("board", wrap(handleBoard));
bot.command("status", wrap(handleStatus));
bot.command("wallet", wrap(handleWallet));
bot.command("fundngn", wrap(handleFundNgn));
bot.command("withdraw", wrap(handleWithdraw));
bot.callbackQuery(/^flt:/, wrap(handleFantasyLeagueTrade));
bot.callbackQuery(/^(start|lobby|arena|funds|wallet):/, wrap(handleFantasyLeagueUiAction));
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
    (config.NODE_ENV !== "production" && normalizedQuery === secret)
  );
}

app.get("/", (_req, res) => {
  res.status(200).send("Bayse fantasy bot is running. Use /health for health checks.");
});

app.get("/health", healthRateLimit, async (req, res) => {
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

app.post("/webhook/pajcash/:secret", pajcashWebhookRateLimit, async (req, res) => {
  const configuredSecret = config.PAJCASH_WEBHOOK_PATH_SECRET?.trim() ?? "";

  if (!configuredSecret) {
    res.sendStatus(404);
    return;
  }

  if (req.params["secret"] !== configuredSecret) {
    console.warn("[pajcash] Rejected webhook with invalid path secret");
    res.sendStatus(403);
    return;
  }

  try {
    await reconcilePajCashWebhook(req.body as Record<string, unknown> as any);
    res.status(200).json({ received: true });
  } catch (error) {
    console.error("[pajcash] Failed to reconcile webhook:", error);
    res.status(200).json({ received: true });
  }
});

app.post("/webhook/:secret", telegramWebhookRateLimit, (req, res) => {
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
  stopSolanaWalletMonitor();

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

  if (config.DASHBOARD_ONLY_MODE) {
    server.listen(config.PORT, () => {
      console.log(
        `[server] Dashboard-only mode enabled.\n` +
          `[server] Listening on port ${config.PORT}\n` +
          `[server] Ready:\n` +
          `  GET /health\n` +
          `  GET /admin/dashboard\n` +
          `  GET /admin/api/dashboard`
      );
    });

    return;
  }

  await redis.ping();
  console.log("[redis] Startup ping OK.");

  await bot.init();
  console.log(`[bot] Initialized as @${bot.botInfo.username}`);

  await bot.api.setMyCommands([
    {
      command: "start",
      description: "Open HeadlineOdds Arena and browse arenas",
    },
    {
      command: "help",
      description: "Show every bot command",
    },
    {
      command: "chart",
      description: "Open the BTC 15m chart link",
    },
    {
      command: "league",
      description: "Create, join, and view fantasy arenas",
    },
    {
      command: "create",
      description: "Create a new fantasy arena",
    },
    {
      command: "join",
      description: "Join an arena by code",
    },
    {
      command: "live",
      description: "View the live round for an arena",
    },
    {
      command: "board",
      description: "Open an arena leaderboard",
    },
    {
      command: "status",
      description: "View arena status details",
    },
    {
      command: "wallet",
      description: "View your Solana USDC wallet and withdraw",
    },
    {
      command: "fundngn",
      description: "Create a Naira top-up order",
    },
    {
      command: "withdraw",
      description: "Withdraw USDC to a Solana wallet",
    },
  ]);

  const chartMenuUrl = getBtcChartMenuUrl();

  if (chartMenuUrl) {
    await bot.api.setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "BTC Chart",
        web_app: {
          url: chartMenuUrl,
        },
      },
    });
  } else {
    await bot.api.setChatMenuButton({
      menu_button: {
        type: "commands",
      },
    });
  }

  startFantasyMonitor();
  startFantasySettlementMonitor();
  startSolanaWalletMonitor();

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
