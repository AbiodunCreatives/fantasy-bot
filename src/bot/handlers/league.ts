import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";

import { getBalance } from "../../db/balances.js";
import {
  buildFantasyTradeDirectionSelection,
  clearFantasyTradePromptState,
  clearPendingFantasyLeagueJoin,
  createFantasyLeagueGame,
  getFantasyLeagueStatusView,
  getFantasyLeagueBoardText,
  getFantasyLeagueDetailsByCode,
  getFantasyLeagueJoinPreview,
  getFantasyLeagueJoinSummary,
  joinFantasyLeagueGame,
  listFantasyArenaLobby,
  listFantasyLeagueSnapshots,
  loadPendingFantasyLeagueJoin,
  placeFantasyTradeFromCallbackData,
  savePendingFantasyLeagueJoin,
  FANTASY_MIN_ENTRY_FEE,
  type FantasyTradePlacementResult,
} from "../../fantasy-league.js";
import {
  ARENA_ENTRY_FEE_OPTIONS,
  buildShareInviteUrl,
  formatCompactDuration,
  formatSignedPercent,
  formatWholeMoney,
  getApproxRoundsUntil,
} from "../../fantasy-ui.js";

const START_HOW_IT_WORKS = "start:how";
const START_LOBBY = "start:lobby";
const LOBBY_REFRESH = "lobby:refresh";
const LOBBY_LIVE = "lobby:live";
const ARENA_CREATE = "arena:create";
const ARENA_BACK_TO_LOBBY = "arena:lobby";
const ARENA_JOIN_CONFIRM = "fantasy:join:confirm";
const ARENA_JOIN_DECLINE = "fantasy:join:decline";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoney(
  value: number,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }
): string {
  return `$${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
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
    "Insufficient play balance.",
    "",
    `You need ${formatMoney(entryFee)} available for this arena entry.`,
    `Your play balance: ${formatMoney(balance)}`,
    "",
    "Arena entries and prizes use your virtual play balance.",
  ].join("\n");
}

function buildStartWelcomeText(): string {
  return [
    "🎯 Bayse Arena",
    "",
    "Fantasy trading on BTC. Real entry. Virtual funds.",
    "Best bankroll wins the pot.",
  ].join("\n");
}

function buildStartWelcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("▶ How it works", START_HOW_IT_WORKS)
    .text("🏟 Browse Arenas", START_LOBBY);
}

function buildHowItWorksText(): string {
  return [
    "1. Pay entry fee ($1-$10)",
    "2. Get virtual funds = fee × 100",
    "3. Trade each 15-min BTC round for 24hrs",
    "4. Top bankroll splits the prize pool",
  ].join("\n");
}

function buildHowItWorksKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Got it - let me in", START_LOBBY);
}

function buildCreateArenaPickerText(balance: number): string {
  return [
    "New Arena",
    "",
    "Pick an entry fee:",
    "",
    `Your balance: ${formatMoney(balance)}`,
  ].join("\n");
}

function buildCreateArenaPickerKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const fee of ARENA_ENTRY_FEE_OPTIONS) {
    keyboard.text(`$${fee}`, `arena:create:${fee}`);
  }

  keyboard.row().text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildArenaStatusText(input: {
  code: string;
  memberCount: number;
  rank: number | null;
  balance: number | null;
  status: string;
  endAt: string;
}): string {
  if (input.status === "OPEN") {
    return `${input.code}  •  OPEN  •  Waiting for players`;
  }

  const rankText =
    input.rank === null ? "Unranked" : `Rank #${input.rank} of ${input.memberCount}`;
  const endText =
    input.status === "LIVE"
      ? `Ends ${formatCompactDuration(Date.parse(input.endAt) - Date.now())}`
      : "Starts next round";
  const balanceText =
    input.balance === null ? "" : `  •  ${formatWholeMoney(input.balance)}`;

  return `${input.code}  •  ${input.status}  •  ${rankText}${balanceText}  •  ${endText}`;
}

function buildActiveArenaListKeyboard(codes: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const code of codes) {
    keyboard
      .text("Status", `arena:status:${code}`)
      .text("Leaderboard", `arena:board:${code}`)
      .row();
  }

  keyboard.text("+ Create New Arena", ARENA_CREATE).text("Browse Lobby", START_LOBBY);
  return keyboard;
}

function buildArenaLobbyText(input: {
  live: Array<{
    code: string;
    entryFee: number;
    memberCount: number;
    prizePool: number;
    endsInText: string;
    startsInText: string | null;
    topReturnPct: number | null;
  }>;
  filling: Array<{
    code: string;
    entryFee: number;
    memberCount: number;
    prizePool: number;
    endsInText: string;
    startsInText: string | null;
    topReturnPct: number | null;
  }>;
  open: Array<{
    code: string;
    entryFee: number;
    memberCount: number;
    prizePool: number;
    endsInText: string;
    startsInText: string | null;
    topReturnPct: number | null;
  }>;
  liveOnly?: boolean;
}): string {
  const sections: string[] = [];

  const pushCard = (
    title: string,
    emoji: string,
    cards: typeof input.live,
    state: "LIVE" | "FILLING" | "OPEN"
  ) => {
    if (cards.length === 0) {
      return;
    }

    sections.push(title, "");

    for (const card of cards) {
      sections.push(
        "━━━━━━━━━━━━━━━━━━",
        `${emoji} ${state}  •  ${formatMoney(card.entryFee, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })} entry  •  ${card.memberCount} players`,
        `Prize pool: ${formatMoney(card.prizePool)}`
      );

      if (state === "LIVE") {
        sections.push(`Ends in: ${card.endsInText}`);

        if (card.topReturnPct !== null && card.memberCount >= 2) {
          sections.push(`Top player: ${formatSignedPercent(card.topReturnPct)} 📈`);
        }
      } else if (state === "FILLING" && card.startsInText) {
        sections.push(`Starts next round (${card.startsInText})`);
      }
    }

    sections.push("");
  };

  pushCard("🏟 LIVE ARENAS", "🔴", input.live, "LIVE");

  if (!input.liveOnly) {
    pushCard("🟡 FILLING ARENAS", "🟡", input.filling, "FILLING");
    pushCard("🟢 OPEN ARENAS", "🟢", input.open, "OPEN");
  }

  if (sections.length === 0) {
    return input.liveOnly
      ? ["No live arenas right now.", "", "Check back soon or create a fresh one."].join("\n")
      : ["No arenas running right now.", "Be the first to create one."].join("\n");
  }

  return sections.join("\n").trim();
}

function buildArenaLobbyKeyboard(input: {
  live: Array<{ code: string; entryFee: number }>;
  filling: Array<{ code: string; entryFee: number }>;
  open: Array<{ code: string; entryFee: number }>;
  liveOnly?: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const card of input.live) {
    keyboard.text(`Watch ${card.code}`, `arena:watch:${card.code}`).row();
  }

  if (!input.liveOnly) {
    for (const card of [...input.filling, ...input.open]) {
      keyboard
        .text(
          `Join ${card.code} - ${formatMoney(card.entryFee, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`,
          `arena:join:${card.code}`
        )
        .row();
    }
  }

  keyboard.text("+ Create New Arena", ARENA_CREATE);

  if (input.liveOnly) {
    keyboard.text("Browse all", START_LOBBY);
  } else {
    keyboard.text("🔄 Refresh", LOBBY_REFRESH);
  }

  return keyboard;
}

function buildFantasyJoinPreviewText(input: {
  code: string;
  entryFee: number;
  virtualFunds: number;
  prizePool: number;
  playerCount: number;
  roundsUntilStart: number;
  currentLeaderName: string | null;
  currentLeaderReturnPct: number | null;
  projectedFirstPrize: number;
  startAt: string;
  balance: number;
  afterJoiningBalance: number;
}): string {
  const startsInText =
    input.roundsUntilStart <= 0
      ? "Starts next round"
      : `Starts in: ${input.roundsUntilStart} rounds (~${input.roundsUntilStart * 15} min)`;

  return [
    `⚡ Arena ${input.code}`,
    "",
    `Entry: ${formatMoney(input.entryFee)}  •  ${input.playerCount} players`,
    `Net prize pool: ${formatMoney(input.prizePool)}`,
    `Your cut if you win 1st: ${formatMoney(input.projectedFirstPrize)}`,
    "",
    startsInText,
    input.currentLeaderName && input.currentLeaderReturnPct !== null
      ? `Current leader: ${input.currentLeaderName}  ${formatSignedPercent(
          input.currentLeaderReturnPct
        )}`
      : `Starts: ${formatDateTime(input.startAt)}`,
    "",
    `Your balance after joining: ${formatMoney(input.afterJoiningBalance)}`,
    `Current balance: ${formatMoney(input.balance)}`,
  ].join("\n");
}

function buildFantasyJoinPreviewKeyboard(entryFee: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `✅ Join - ${formatMoney(entryFee, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })}`,
      ARENA_JOIN_CONFIRM
    )
    .text("❌ Cancel", ARENA_JOIN_DECLINE);
}

function buildFantasyCreateSuccessText(input: {
  code: string;
  prizePool: number;
  virtualStack: number;
  roundsUntilStart: number;
}): string {
  return [
    "✅ Arena created",
    "",
    `Code: ${input.code}`,
    `Prize pool: ${formatMoney(input.prizePool)} (grows as others join)`,
    `Your virtual stack: ${formatWholeMoney(input.virtualStack)}`,
    input.roundsUntilStart <= 0
      ? "Starts: next BTC round"
      : `Starts: next BTC round (~${input.roundsUntilStart * 15} min)`,
    "",
    "I'll ping you when round 1 opens.",
  ].join("\n");
}

function buildFantasyJoinSuccessText(input: {
  code: string;
  virtualBalance: number;
  playBalance: number;
  prizePool: number;
  playerCount: number;
  roundsUntilStart: number;
}): string {
  return [
    "You're in. 🟢",
    "",
    `Arena: ${input.code}`,
    `Your virtual stack: ${formatWholeMoney(input.virtualBalance)}`,
    `Prize pool: ${formatMoney(input.prizePool)} (${input.playerCount} players)`,
    "",
    input.roundsUntilStart <= 0
      ? "Starts in: next BTC round"
      : `Starts in: ~${input.roundsUntilStart * 15} min`,
    `Play balance: ${formatMoney(input.playBalance)}`,
    "I'll ping you when round 1 opens.",
  ].join("\n");
}

function buildInsufficientBalanceWithOptionsText(balance: number): string {
  return [
    "You need funds to join an arena.",
    "",
    `Your balance: ${formatMoney(balance)}`,
  ].join("\n");
}

function buildInsufficientBalanceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💳 Add Funds", "funds:add")
    .text("👀 Watch live arena", LOBBY_LIVE);
}

function buildFantasyJoinSuccessKeyboard(shareUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (shareUrl) {
    keyboard.url("📤 Invite others", shareUrl);
  }

  keyboard.text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildFantasyCreateSuccessKeyboard(shareUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (shareUrl) {
    keyboard.url("📤 Share invite", shareUrl);
  }

  keyboard.text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildLeagueHelpText(): string {
  return [
    "BAYSE FANTASY ARENA",
    "",
    "Commands:",
    "/start - Open the welcome screen and lobby",
    "/league - See your active arenas or browse the lobby",
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
    `New users start with ${formatMoney(FANTASY_MIN_ENTRY_FEE * 100)} in virtual play balance.`,
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

  if (
    normalized.includes("insufficient play balance") ||
    normalized.includes("insufficient balance")
  ) {
    if (!ctx.from) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    const [details, balance] = await Promise.all([
      code ? getFantasyLeagueDetailsByCode(code).catch(() => null) : Promise.resolve(null),
      getBalance(ctx.from.id),
    ]);
    const entryFee = details?.game.entry_fee ?? 0;

    await ctx.reply(buildArenaInsufficientBalanceText(entryFee, balance), {
      reply_markup: buildInsufficientBalanceKeyboard(),
    });
    return;
  }

  if (normalized.includes("already joined")) {
    await ctx.reply("You already joined this arena.");
    return;
  }

  await ctx.reply("Something went wrong. Please try again.");
}

function getPromptMessageRef(ctx: Context): {
  chatId: number | undefined;
  messageId: number | undefined;
} {
  const message = ctx.callbackQuery?.message;

  return {
    chatId: ctx.chat?.id,
    messageId:
      message && "message_id" in message ? message.message_id : undefined,
  };
}

function isWarmRoundCloseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  return (
    message.includes("round has ended") ||
    message.includes("round is no longer available") ||
    message.includes("league is not active right now") ||
    message.includes("league has already ended")
  );
}

function buildRoundClosedText(): string {
  return [
    "That round just closed before your trade locked in.",
    "",
    "No trade was placed.",
    "You're still in it. I will send the next BTC prompt shortly.",
  ].join("\n");
}

function buildTradeAlreadyLockedText(): string {
  return [
    "That round is already locked in.",
    "",
    "Watch for the result after the close.",
  ].join("\n");
}

function buildTradeLockedText(result: FantasyTradePlacementResult): string {
  return [
    `Round ${result.roundNumber} locked in - ${result.game.code}`,
    "",
    `Direction: ${result.direction}`,
    `Stake: ${formatMoney(result.stake)}`,
    `Entry price: ${Math.round(result.entryPrice * 100)}c`,
    `Shares: ${result.shares.toFixed(2)}`,
    `Virtual balance: ${formatMoney(result.remainingBalance)}`,
    "",
    "Nice. I'll send the result after the round closes.",
  ].join("\n");
}

async function editTradePromptMessage(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  const { chatId, messageId } = getPromptMessageRef(ctx);

  if (chatId !== undefined && messageId !== undefined) {
    try {
      await ctx.editMessageText(text, {
        reply_markup: keyboard ?? new InlineKeyboard(),
      });
      return;
    } catch (error) {
      const normalized = error instanceof Error ? error.message.toLowerCase() : "";

      if (normalized.includes("message is not modified")) {
        return;
      }
    }
  }

  if (keyboard) {
    await ctx.reply(text, { reply_markup: keyboard });
    return;
  }

  await ctx.reply(text);
}

async function renderArenaLobby(
  ctx: Context,
  options?: { liveOnly?: boolean }
): Promise<void> {
  const lobby = await listFantasyArenaLobby();
  const mapCard = (card: (typeof lobby.live)[number]) => ({
    code: card.game.code,
    entryFee: card.game.entry_fee,
    memberCount: card.memberCount,
    prizePool: card.game.prize_pool,
    endsInText: formatCompactDuration(Date.parse(card.game.end_at) - Date.now()),
    startsInText:
      card.state === "FILLING"
        ? `~${Math.max(1, getApproxRoundsUntil(card.game.start_at)) * 15} min`
        : null,
    topReturnPct: card.topLeaderReturnPct,
  });

  const live = lobby.live.map(mapCard);
  const filling = lobby.filling.map(mapCard);
  const open = lobby.open.map(mapCard);

  await editTradePromptMessage(
    ctx,
    buildArenaLobbyText({
      live,
      filling,
      open,
      liveOnly: options?.liveOnly,
    }),
    buildArenaLobbyKeyboard({
      live,
      filling,
      open,
      liveOnly: options?.liveOnly,
    })
  );
}

async function renderArenaStatusList(ctx: Context, telegramId: number): Promise<void> {
  const snapshots = await listFantasyLeagueSnapshots(telegramId);

  if (snapshots.length === 0) {
    await renderArenaLobby(ctx);
    return;
  }

  const lines = snapshots.map((snapshot) =>
    buildArenaStatusText({
      code: snapshot.game.code,
      memberCount: snapshot.memberCount,
      rank: snapshot.yourRank,
      balance: snapshot.yourVirtualBalance,
      status:
        snapshot.game.status === "active"
          ? "LIVE"
          : snapshot.game.status === "open"
            ? "OPEN"
            : snapshot.game.status.toUpperCase(),
      endAt: snapshot.game.end_at,
    })
  );

  await ctx.reply(
    ["Your active arenas:", "", ...lines].join("\n"),
    {
      reply_markup: buildActiveArenaListKeyboard(
        snapshots.map((snapshot) => snapshot.game.code)
      ),
    }
  );
}

async function presentJoinPreview(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const [preview, balance] = await Promise.all([
    getFantasyLeagueJoinPreview(telegramId, code),
    getBalance(telegramId),
  ]);

  if (balance < preview.game.entry_fee) {
    await editTradePromptMessage(
      ctx,
      buildArenaInsufficientBalanceText(preview.game.entry_fee, balance),
      buildInsufficientBalanceKeyboard()
    );
    return;
  }

  await savePendingFantasyLeagueJoin(telegramId, preview.game.code);

  await editTradePromptMessage(
    ctx,
    buildFantasyJoinPreviewText({
      code: preview.game.code,
      entryFee: preview.game.entry_fee,
      virtualFunds: preview.game.virtual_start_balance,
      prizePool: preview.projectedPrizePool,
      playerCount: preview.memberCount,
      roundsUntilStart: getApproxRoundsUntil(preview.game.start_at),
      currentLeaderName: preview.currentLeaderName,
      currentLeaderReturnPct: preview.currentLeaderReturnPct,
      projectedFirstPrize: preview.projectedFirstPrize,
      startAt: preview.game.start_at,
      balance,
      afterJoiningBalance: roundMoney(balance - preview.game.entry_fee),
    }),
    buildFantasyJoinPreviewKeyboard(preview.game.entry_fee)
  );
}

async function renderArenaStatusView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const settledTrades =
    (view.me?.wins ?? 0) + (view.me?.losses ?? 0);
  const accuracyText =
    settledTrades > 0
      ? `${view.me?.wins ?? 0}/${settledTrades} (${roundMoney(
          ((view.me?.wins ?? 0) / settledTrades) * 100
        )}%)`
      : "0/0 (0%)";
  const lastRoundText = view.lastTrade
    ? `${view.lastTrade.direction} ${
        view.lastTrade.outcome === "WIN"
          ? "✅"
          : view.lastTrade.outcome === "LOSS"
            ? "❌"
            : "•"
      }  ${view.lastTrade.outcome === "WIN" ? `+${formatMoney(view.lastTrade.payout)}` : ""}`.trim()
    : "No trades yet";

  const text = [
    `Arena ${view.game.code}  •  ${view.game.status.toUpperCase()}`,
    "",
    `Your position: ${
      view.me ? `#${view.me.place} of ${view.memberCount}` : "Not joined"
    }`,
    `Stack: ${formatWholeMoney(view.me?.virtual_balance ?? view.game.virtual_start_balance)}  (${formatSignedPercent(
      view.me
        ? ((view.me.virtual_balance - view.game.virtual_start_balance) /
            view.game.virtual_start_balance) *
            100
        : 0
    )})`,
    `Rounds left: ~${view.roundsLeft}  (~${view.roundsLeft * 15} min)`,
    `Prize if game ends now: ${formatMoney(view.prizeIfEndedNow)}`,
    "",
    `Last round: ${lastRoundText}`,
    `Accuracy: ${accuracyText}`,
  ].join("\n");

  await editTradePromptMessage(
    ctx,
    text,
    new InlineKeyboard()
      .text("Full leaderboard", `arena:board:${view.game.code}`)
      .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY)
  );
}

async function renderArenaWatchView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const text = await getFantasyLeagueBoardText(code, telegramId);

  await editTradePromptMessage(
    ctx,
    ["👀 Spectating", "", text].join("\n"),
    new InlineKeyboard().text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY)
  );
}

async function createArenaFromSelection(
  ctx: Context,
  telegramId: number,
  entryFee: number
): Promise<void> {
  const game = await createFantasyLeagueGame(telegramId, entryFee);
  const me = await ctx.api.getMe();
  const shareUrl = buildShareInviteUrl({
    botUsername: me.username,
    code: game.code,
    entryFee: game.entry_fee,
  });

  await editTradePromptMessage(
    ctx,
    buildFantasyCreateSuccessText({
      code: game.code,
      prizePool: game.prize_pool,
      virtualStack: game.virtual_start_balance,
      roundsUntilStart: getApproxRoundsUntil(game.start_at),
    }),
    buildFantasyCreateSuccessKeyboard(shareUrl)
  );
}

export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const code = args[0]?.trim().toUpperCase();

  if (code) {
    try {
      await presentJoinPreview(ctx, ctx.from.id, code);
    } catch (error) {
      await replyFantasyJoinError(ctx, error, code);
    }

    return;
  }

  await ctx.reply(buildStartWelcomeText(), {
    reply_markup: buildStartWelcomeKeyboard(),
  });
}

export async function handleFantasyLeagueUiAction(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery?.data) {
    return;
  }

  const data = ctx.callbackQuery.data;

  if (data === START_HOW_IT_WORKS) {
    await editTradePromptMessage(ctx, buildHowItWorksText(), buildHowItWorksKeyboard());
    return;
  }

  if (data === START_LOBBY || data === LOBBY_REFRESH || data === ARENA_BACK_TO_LOBBY) {
    await renderArenaLobby(ctx);
    return;
  }

  if (data === LOBBY_LIVE) {
    await renderArenaLobby(ctx, { liveOnly: true });
    return;
  }

  if (data === ARENA_CREATE) {
    const balance = await getBalance(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildCreateArenaPickerText(balance),
      buildCreateArenaPickerKeyboard()
    );
    return;
  }

  if (data.startsWith("arena:create:")) {
    const entryFee = Number.parseFloat(data.slice("arena:create:".length));

    if (!Number.isFinite(entryFee)) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    try {
      await createArenaFromSelection(ctx, ctx.from.id, entryFee);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";

      if (message.includes("insufficient play balance")) {
        const balance = await getBalance(ctx.from.id);
        await editTradePromptMessage(
          ctx,
          buildArenaInsufficientBalanceText(entryFee, balance),
          buildInsufficientBalanceKeyboard()
        );
        return;
      }

      throw error;
    }

    return;
  }

  if (data.startsWith("arena:join:")) {
    try {
      await presentJoinPreview(ctx, ctx.from.id, data.slice("arena:join:".length));
    } catch (error) {
      await replyFantasyJoinError(ctx, error, data.slice("arena:join:".length));
    }
    return;
  }

  if (data.startsWith("arena:watch:")) {
    try {
      await renderArenaWatchView(ctx, ctx.from.id, data.slice("arena:watch:".length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith("arena:board:")) {
    try {
      await editTradePromptMessage(
        ctx,
        await getFantasyLeagueBoardText(data.slice("arena:board:".length), ctx.from.id),
        new InlineKeyboard()
          .text("Status", `arena:status:${data.slice("arena:board:".length)}`)
          .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY)
      );
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith("arena:status:")) {
    try {
      await renderArenaStatusView(ctx, ctx.from.id, data.slice("arena:status:".length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }
}

export async function handleLeague(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand) {
    await renderArenaStatusList(ctx, ctx.from.id);
    return;
  }

  if (subcommand === "create") {
    const entryFee = Number.parseFloat(args[1] ?? "");

    if (!Number.isFinite(entryFee)) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(buildCreateArenaPickerText(balance), {
        reply_markup: buildCreateArenaPickerKeyboard(),
      });
      return;
    }

    try {
      const game = await createFantasyLeagueGame(ctx.from.id, entryFee);
      const me = await ctx.api.getMe();

      await ctx.reply(
        buildFantasyCreateSuccessText({
          code: game.code,
          prizePool: game.prize_pool,
          virtualStack: game.virtual_start_balance,
          roundsUntilStart: getApproxRoundsUntil(game.start_at),
        }),
        {
          reply_markup: buildFantasyCreateSuccessKeyboard(
            buildShareInviteUrl({
              botUsername: me.username,
              code: game.code,
              entryFee: game.entry_fee,
            })
          ),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";

      if (
        message.includes("insufficient play balance") ||
        message.includes("insufficient balance")
      ) {
        const balance = await getBalance(ctx.from.id);
        await ctx.reply(buildArenaInsufficientBalanceText(entryFee, balance), {
          reply_markup: buildInsufficientBalanceKeyboard(),
        });
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
      await presentJoinPreview(ctx, ctx.from.id, code);
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
      await ctx.reply(await getFantasyLeagueBoardText(code, ctx.from.id));
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

  const callbackData = ctx.callbackQuery.data;
  const { chatId, messageId } = getPromptMessageRef(ctx);

  if (callbackData.startsWith("flt:s:")) {
    try {
      const directionSelection = await buildFantasyTradeDirectionSelection({
        telegramId: ctx.from.id,
        callbackData,
        chatId,
        messageId,
      });

      await editTradePromptMessage(
        ctx,
        directionSelection.text,
        directionSelection.keyboard
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";

      if (isWarmRoundCloseError(error)) {
        clearFantasyTradePromptState(chatId, messageId);
        await editTradePromptMessage(ctx, buildRoundClosedText());
        return;
      }

      if (message) {
        await ctx.reply(message);
        return;
      }

      throw error;
    }
  }

  try {
    const result = await placeFantasyTradeFromCallbackData({
      telegramId: ctx.from.id,
      callbackData,
    });

    clearFantasyTradePromptState(chatId, messageId);
    await editTradePromptMessage(ctx, buildTradeLockedText(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const normalized = message.toLowerCase();

    if (isWarmRoundCloseError(error)) {
      clearFantasyTradePromptState(chatId, messageId);
      await editTradePromptMessage(ctx, buildRoundClosedText());
      return;
    }

    if (normalized.includes("already placed a fantasy trade")) {
      clearFantasyTradePromptState(chatId, messageId);
      await editTradePromptMessage(ctx, buildTradeAlreadyLockedText());
      return;
    }

    if (message) {
      await ctx.reply(message);
      return;
    }

    throw error;
  }
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
    const leaderboard = await getFantasyLeagueDetailsByCode(game.code);
    const me = await ctx.api.getMe();

    await editTradePromptMessage(
      ctx,
      buildFantasyJoinSuccessText({
        code: game.code,
        virtualBalance: game.virtual_start_balance,
        playBalance: balance,
        prizePool: leaderboard.game.prize_pool,
        playerCount: leaderboard.memberCount,
        roundsUntilStart: getApproxRoundsUntil(game.start_at),
      }),
      buildFantasyJoinSuccessKeyboard(
        buildShareInviteUrl({
          botUsername: me.username,
          code: game.code,
          entryFee: game.entry_fee,
        })
      )
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
