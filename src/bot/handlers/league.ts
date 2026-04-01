import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";

import { getBalance } from "../../db/balances.js";
import {
  clearPendingFantasyLeagueJoin,
  createFantasyLeagueGame,
  getFantasyLeagueBoardText,
  getFantasyLeagueDetailsByCode,
  getFantasyLeagueJoinPreview,
  getFantasyLeagueJoinSummary,
  joinFantasyLeagueGame,
  listFantasyLeagueSnapshots,
  loadPendingFantasyLeagueJoin,
  placeFantasyTradeFromCallbackData,
  savePendingFantasyLeagueJoin,
} from "../../fantasy-league.js";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoney(value: number): string {
  return `$${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })} at ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function buildArenaNotFoundText(): string {
  return [
    "Arena not found.",
    "",
    "Check the code and try again, or create your own with /league create <entry_fee>.",
  ].join("\n");
}

function buildArenaStartedText(): string {
  return [
    "This arena has already started.",
    "",
    "You can create your own with /league create <entry_fee>.",
  ].join("\n");
}

function buildArenaInsufficientBalanceText(
  entryFee: number,
  balance: number
): string {
  return [
    "Insufficient balance.",
    "",
    `You need ${formatMoney(entryFee)} to join this arena.`,
    `Your balance: ${formatMoney(balance)}`,
    "",
    "This extracted app still uses the internal balance ledger.",
    "Wire a funding flow next, or credit the balance manually.",
  ].join("\n");
}

function buildFantasyJoinPreviewText(input: {
  code: string;
  entryFee: number;
  virtualFunds: number;
  prizePool: number;
  playerCount: number;
  startAt: string;
  endAt: string;
  balance: number;
  afterJoiningBalance: number;
}): string {
  return [
    "BAYSE FANTASY ARENA",
    "",
    `League Code: ${input.code}`,
    `Entry Fee: ${formatMoney(input.entryFee)}`,
    `Virtual Funds: ${formatMoney(input.virtualFunds)}`,
    `Prize Pool: ${formatMoney(input.prizePool)}`,
    `Players joined: ${input.playerCount}`,
    "Duration: 24 hours",
    `Starts: ${formatDateTime(input.startAt)}`,
    `Ends: ${formatDateTime(input.endAt)}`,
    "",
    "Joining is final. No refunds after you join.",
    "",
    `Your balance: ${formatMoney(input.balance)}`,
    `After joining: ${formatMoney(input.afterJoiningBalance)}`,
  ].join("\n");
}

function buildFantasyJoinSuccessText(input: {
  code: string;
  virtualBalance: number;
  cashBalance: number;
}): string {
  return [
    "BAYSE FANTASY ARENA",
    "",
    "You're in. Welcome to the arena.",
    "",
    `League: ${input.code}`,
    `Virtual balance: ${formatMoney(input.virtualBalance)}`,
    `Cash balance: ${formatMoney(input.cashBalance)}`,
    "",
    "You'll receive BTC 15-minute trading prompts from the next round onward.",
  ].join("\n");
}

function buildLeagueHelpText(): string {
  return [
    "BAYSE FANTASY ARENA",
    "",
    "Commands:",
    "/league create 5 - Create a BTC 24h fantasy arena with $5 entry",
    "/league join ABC123 - Review and join an arena by code",
    "/league board ABC123 - View the arena leaderboard",
    "/league status ABC123 - View arena details",
    "",
    "Rules:",
    "- BTC only in v1",
    "- Next 24 hours of Bayse BTC 15M rounds",
    "- Entry fee buys virtual bankroll at 100x",
    "- One fantasy trade per round",
    "- Bot keeps 8% commission when the league closes",
    "- Top finishers split the prize pool",
    "- Joining is final",
    "",
    "This scaffold still assumes balances already exist in the shared ledger.",
  ].join("\n");
}

async function replyArenaLookupError(ctx: Context, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (
    message.includes("arena not found") ||
    message.includes("league not found")
  ) {
    await ctx.reply(buildArenaNotFoundText());
    return;
  }

  await ctx.reply("Something went wrong. Please try again.");
}

async function replyFantasyJoinError(
  ctx: Context,
  error: unknown,
  code?: string
): Promise<void> {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (
    normalized.includes("arena not found") ||
    normalized.includes("league not found")
  ) {
    await ctx.reply(buildArenaNotFoundText());
    return;
  }

  if (
    normalized.includes("already started") ||
    normalized.includes("no longer open for joining")
  ) {
    await ctx.reply(buildArenaStartedText());
    return;
  }

  if (normalized.includes("insufficient balance")) {
    if (!ctx.from) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    const [details, balance] = await Promise.all([
      code ? getFantasyLeagueDetailsByCode(code).catch(() => null) : Promise.resolve(null),
      getBalance(ctx.from.id),
    ]);
    const entryFee = details?.game.entry_fee ?? 0;

    await ctx.reply(buildArenaInsufficientBalanceText(entryFee, balance));
    return;
  }

  if (normalized.includes("already joined")) {
    await ctx.reply("You already joined this arena.");
    return;
  }

  await ctx.reply("Something went wrong. Please try again.");
}

export async function handleLeague(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand) {
    const snapshots = await listFantasyLeagueSnapshots(ctx.from.id);

    if (snapshots.length === 0) {
      await ctx.reply(buildLeagueHelpText());
      return;
    }

    const lines = snapshots.map((snapshot) => {
      const rankText =
        snapshot.yourRank === null ? "Unranked" : `#${snapshot.yourRank}`;
      const balanceText =
        snapshot.yourVirtualBalance === null
          ? "N/A"
          : formatMoney(snapshot.yourVirtualBalance);

      return (
        `${snapshot.game.code} - ${snapshot.game.status.toUpperCase()} ` +
        `(${snapshot.memberCount} players, ${rankText}, ${balanceText})`
      );
    });

    await ctx.reply(
      [
        "YOUR BAYSE FANTASY ARENAS",
        "",
        ...lines,
        "",
        buildLeagueHelpText(),
      ].join("\n")
    );
    return;
  }

  if (subcommand === "create") {
    const entryFee = Number.parseFloat(args[1] ?? "");

    if (!Number.isFinite(entryFee)) {
      await ctx.reply("Usage: /league create 5");
      return;
    }

    try {
      const game = await createFantasyLeagueGame(ctx.from.id, entryFee);

      await ctx.reply(
        [
          "BAYSE FANTASY ARENA CREATED",
          "",
          `League Code: ${game.code}`,
          `Entry Fee: ${formatMoney(game.entry_fee)}`,
          `Virtual Funds: ${formatMoney(game.virtual_start_balance)}`,
          `Prize Pool: ${formatMoney(game.prize_pool)}`,
          "Duration: 24 hours",
          `Starts: ${formatDateTime(game.start_at)}`,
          `Ends: ${formatDateTime(game.end_at)}`,
          "",
          "Joining is final. No refunds after you join.",
          "",
          `Share this join code: /league join ${game.code}`,
        ].join("\n")
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";

      if (message.includes("insufficient balance")) {
        const balance = await getBalance(ctx.from.id);
        await ctx.reply(buildArenaInsufficientBalanceText(entryFee, balance));
        return;
      }

      await ctx.reply("Something went wrong. Please try again.");
    }

    return;
  }

  if (subcommand === "join") {
    const code = args[1]?.trim().toUpperCase();

    if (!code) {
      await ctx.reply("Usage: /league join ABC123");
      return;
    }

    try {
      const [preview, balance] = await Promise.all([
        getFantasyLeagueJoinPreview(ctx.from.id, code),
        getBalance(ctx.from.id),
      ]);

      if (balance < preview.game.entry_fee) {
        await ctx.reply(
          buildArenaInsufficientBalanceText(preview.game.entry_fee, balance)
        );
        return;
      }

      await savePendingFantasyLeagueJoin(ctx.from.id, preview.game.code);

      await ctx.reply(
        buildFantasyJoinPreviewText({
          code: preview.game.code,
          entryFee: preview.game.entry_fee,
          virtualFunds: preview.game.virtual_start_balance,
          prizePool: preview.projectedPrizePool,
          playerCount: preview.memberCount,
          startAt: preview.game.start_at,
          endAt: preview.game.end_at,
          balance,
          afterJoiningBalance: roundMoney(balance - preview.game.entry_fee),
        }),
        {
          reply_markup: new InlineKeyboard()
            .text("Join Arena", "fantasy:join:confirm")
            .text("Decline", "fantasy:join:decline"),
        }
      );
    } catch (error) {
      await replyFantasyJoinError(ctx, error, code);
    }

    return;
  }

  if (subcommand === "board") {
    const code = args[1]?.trim().toUpperCase();

    if (!code) {
      await ctx.reply("Usage: /league board ABC123");
      return;
    }

    try {
      await ctx.reply(await getFantasyLeagueBoardText(code));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }

    return;
  }

  if (subcommand === "status") {
    const code = args[1]?.trim().toUpperCase();

    if (!code) {
      await ctx.reply("Usage: /league status ABC123");
      return;
    }

    try {
      await ctx.reply(await getFantasyLeagueJoinSummary(code));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }

    return;
  }

  await ctx.reply(buildLeagueHelpText());
}

export async function handleFantasyLeagueTrade(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery?.data) {
    return;
  }

  const result = await placeFantasyTradeFromCallbackData({
    telegramId: ctx.from.id,
    callbackData: ctx.callbackQuery.data,
  });

  await ctx.reply(
    [
      `BAYSE FANTASY ARENA TRADE LOCKED - ${result.game.code}`,
      "",
      `Direction: ${result.direction}`,
      `Stake: ${formatMoney(result.stake)}`,
      `Entry price: ${Math.round(result.entryPrice * 100)}c`,
      `Shares: ${result.shares.toFixed(2)}`,
      `Virtual balance: ${formatMoney(result.remainingBalance)}`,
    ].join("\n")
  );
}

export async function handleFantasyJoinConfirm(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const code = await loadPendingFantasyLeagueJoin(ctx.from.id);

  if (!code) {
    await ctx.reply("This invitation expired. Please use /league join CODE again.");
    return;
  }

  try {
    const game = await joinFantasyLeagueGame(ctx.from.id, code);
    await clearPendingFantasyLeagueJoin(ctx.from.id);
    const balance = await getBalance(ctx.from.id);

    await ctx.reply(
      buildFantasyJoinSuccessText({
        code: game.code,
        virtualBalance: game.virtual_start_balance,
        cashBalance: balance,
      })
    );
  } catch (error) {
    await replyFantasyJoinError(ctx, error, code);
  }
}

export async function handleFantasyJoinDecline(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const code = await loadPendingFantasyLeagueJoin(ctx.from.id);

  if (!code) {
    await ctx.reply("This invitation expired. Please use /league join CODE again.");
    return;
  }

  await clearPendingFantasyLeagueJoin(ctx.from.id);
  await ctx.reply(
    `No problem. You can join anytime before the league starts with /league join ${code}`
  );
}
