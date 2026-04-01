import { Api, InlineKeyboard } from "grammy";

import {
  getCurrentRound,
  getEventPricing,
  getEvent,
  type Round,
  type RoundPricing,
} from "./bayse-market.js";
import { config } from "./config.js";
import { creditBalance, debitBalance } from "./db/balances.js";
import {
  addFantasyGameMember,
  applyFantasyTradeSettlement,
  awardFantasyPrize,
  createFantasyGame,
  creditFantasyBalance,
  debitFantasyBalance,
  getFantasyGameByCode,
  getFantasyGameById,
  getFantasyGameMember,
  getFantasyLeaderboard,
  getFantasyTradeForMemberEvent,
  incrementFantasyMemberTradeCount,
  listActiveFantasyGames,
  listDueOpenFantasyGames,
  listFantasyGameMembers,
  listFantasyPayouts,
  listFinalizableFantasyGames,
  listPendingFantasyTrades,
  listFantasyTradesForGameEvent,
  listPendingFantasyTradesForGame,
  listUserFantasyGames,
  recalculateFantasyPrizePool,
  recordFantasyTrade,
  reopenFantasyTradeSettlement,
  revokeFantasyPrize,
  settleFantasyTrade,
  syncFantasyPrizeAwards,
  updateFantasyGame,
  type FantasyGame,
  type FantasyLeaderboardEntry,
  type FantasyTrade,
  type FantasyTradeDirection,
} from "./db/fantasy.js";
import { recordRevenueOnce } from "./db/revenue.js";
import { redis } from "./utils/rateLimit.js";

const tgApi = new Api(config.BOT_TOKEN);

export const FANTASY_ASSET = "BTC" as const;
export const FANTASY_DURATION_MS = 24 * 60 * 60 * 1000;
export const FANTASY_ENTRY_MULTIPLIER = 100;
export const FANTASY_COMMISSION_RATE = 0.08;
export const FANTASY_MIN_ENTRY_FEE = 1;
export const FANTASY_MAX_ENTRY_FEE = 10;
export const FANTASY_TRADE_AMOUNTS = [10, 25, 50, 100] as const;
const FANTASY_ROUND_ALERT_MAX_PROGRESS = 0.2;
const FANTASY_JOIN_PENDING_TTL_SECONDS = 5 * 60;
const FANTASY_TRADE_REF_TTL_SECONDS = 15 * 60;

interface FantasyTradeRefPayload {
  gameId: string;
  eventId: string;
  marketId: string;
  direction: FantasyTradeDirection;
}

export interface FantasyGameSnapshot {
  game: FantasyGame;
  memberCount: number;
  yourRank: number | null;
  yourVirtualBalance: number | null;
}

export interface FantasyLeagueJoinPreview {
  game: FantasyGame;
  memberCount: number;
  projectedPrizePool: number;
}

export interface FantasyTradePlacementResult {
  game: FantasyGame;
  stake: number;
  direction: FantasyTradeDirection;
  entryPrice: number;
  shares: number;
  remainingBalance: number;
}

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

function shortCode(length = 6): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .toUpperCase();
}

async function generateUniqueFantasyGameCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = shortCode();
    const existing = await getFantasyGameByCode(code);

    if (!existing) {
      return code;
    }
  }

  throw new Error("Unable to generate a unique Bayse Fantasy Arena code.");
}

function fantasyTradeRefKey(ref: string): string {
  return `fantasy:trade:${ref}`;
}

function fantasyJoinPendingKey(telegramId: number): string {
  return `fantasy:join:pending:${telegramId}`;
}

async function saveFantasyTradeReference(
  payload: FantasyTradeRefPayload
): Promise<string> {
  const ref = `${payload.gameId}:${payload.eventId}:${payload.marketId}:${payload.direction}`
    .replace(/[^a-zA-Z0-9:]/g, "")
    .slice(0, 32);
  const uniqueRef = `${ref}:${Date.now().toString(36)}`.slice(0, 48);
  const redisKey = fantasyTradeRefKey(uniqueRef);

  console.log(
    `[fantasy] Storing context at key: ${redisKey} with TTL: ${FANTASY_TRADE_REF_TTL_SECONDS}`
  );

  await redis.set(
    redisKey,
    JSON.stringify(payload),
    "EX",
    FANTASY_TRADE_REF_TTL_SECONDS
  );

  return uniqueRef;
}

export async function savePendingFantasyLeagueJoin(
  telegramId: number,
  code: string
): Promise<void> {
  await redis.set(
    fantasyJoinPendingKey(telegramId),
    JSON.stringify({ code: code.trim().toUpperCase() }),
    "EX",
    FANTASY_JOIN_PENDING_TTL_SECONDS
  );
}

export async function loadPendingFantasyLeagueJoin(
  telegramId: number
): Promise<string | null> {
  const raw = await redis.get(fantasyJoinPendingKey(telegramId));

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { code?: unknown };

    if (typeof parsed.code !== "string" || !parsed.code.trim()) {
      return null;
    }

    return parsed.code.trim().toUpperCase();
  } catch {
    return null;
  }
}

export async function clearPendingFantasyLeagueJoin(
  telegramId: number
): Promise<void> {
  await redis.del(fantasyJoinPendingKey(telegramId));
}

async function loadFantasyTradeReference(
  ref: string
): Promise<FantasyTradeRefPayload | null> {
  const redisKey = fantasyTradeRefKey(ref);

  console.log(`[fantasy] Reading trade context from key: ${redisKey}`);

  const cached = await redis.get(redisKey);

  console.log(`[fantasy] Redis key: ${redisKey}, cached value: ${cached}`);

  console.log(
    `[fantasy] Trade lookup - key: ${redisKey}, value: ${JSON.stringify(cached)}`
  );

  if (!cached) {
    return null;
  }

  try {
    const parsed = JSON.parse(cached) as FantasyTradeRefPayload;

    if (
      !parsed.gameId ||
      !parsed.eventId ||
      !parsed.marketId ||
      (parsed.direction !== "UP" && parsed.direction !== "DOWN")
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function buildFantasyTradeButtonData(
  amount: number,
  payload: FantasyTradeRefPayload
): Promise<string> {
  const ref = await saveFantasyTradeReference(payload);
  return `flt:${amount}:r:${ref}`;
}

async function buildFantasyTradeKeyboard(input: {
  gameId: string;
  eventId: string;
  marketId: string;
}): Promise<InlineKeyboard> {
  const [upButtons, downButtons] = await Promise.all([
    Promise.all(
      FANTASY_TRADE_AMOUNTS.map((amount) =>
        buildFantasyTradeButtonData(amount, {
          gameId: input.gameId,
          eventId: input.eventId,
          marketId: input.marketId,
          direction: "UP",
        })
      )
    ),
    Promise.all(
      FANTASY_TRADE_AMOUNTS.map((amount) =>
        buildFantasyTradeButtonData(amount, {
          gameId: input.gameId,
          eventId: input.eventId,
          marketId: input.marketId,
          direction: "DOWN",
        })
      )
    ),
  ]);

  const keyboard = new InlineKeyboard();

  for (const [index, amount] of FANTASY_TRADE_AMOUNTS.entries()) {
    keyboard.text(`UP $${amount}`, upButtons[index] ?? "");
  }

  keyboard.row();

  for (const [index, amount] of FANTASY_TRADE_AMOUNTS.entries()) {
    keyboard.text(`DOWN $${amount}`, downButtons[index] ?? "");
  }

  return keyboard;
}

function inferResolvedDirection(payload: unknown): FantasyTradeDirection | null {
  const record = payload as {
    status?: unknown;
    markets?: Array<{
      status?: unknown;
      resolvedOutcome?: unknown;
    }>;
  };
  const eventStatus =
    typeof record.status === "string" ? record.status.toLowerCase() : "";
  const market = record.markets?.[0];
  const marketStatus =
    typeof market?.status === "string" ? market.status.toLowerCase() : "";
  const resolvedOutcome =
    typeof market?.resolvedOutcome === "string"
      ? market.resolvedOutcome.toUpperCase()
      : "";

  if (eventStatus !== "resolved" || marketStatus !== "resolved") {
    return null;
  }

  if (resolvedOutcome === "YES") {
    return "UP";
  }

  if (resolvedOutcome === "NO") {
    return "DOWN";
  }

  return null;
}

function getPrizeSplits(playerCount: number): number[] {
  if (playerCount <= 1) {
    return [1];
  }

  if (playerCount === 2) {
    return [0.6, 0.4];
  }

  return [0.5, 0.3, 0.2];
}

function getPrizePoolBreakdown(entryFee: number, playerCount: number): {
  grossPrizePool: number;
  commissionAmount: number;
  netPrizePool: number;
} {
  const grossPrizePool = roundMoney(entryFee * playerCount);
  const commissionAmount = roundMoney(
    Math.max(0, grossPrizePool * FANTASY_COMMISSION_RATE)
  );

  return {
    grossPrizePool,
    commissionAmount,
    netPrizePool: roundMoney(Math.max(0, grossPrizePool - commissionAmount)),
  };
}

function buildPrizePoolLines(entryFee: number, playerCount: number): string[] {
  const breakdown = getPrizePoolBreakdown(entryFee, playerCount);

  return [
    `Gross entry pool: ${formatMoney(breakdown.grossPrizePool)}`,
    `Bot commission (8%): ${formatMoney(breakdown.commissionAmount)}`,
    `Net prize pool: ${formatMoney(breakdown.netPrizePool)}`,
  ];
}

function formatResolvedDirection(direction: FantasyTradeDirection): string {
  return direction === "UP" ? "UP (YES)" : "DOWN (NO)";
}

function buildRoundBroadcastMessage(input: {
  game: FantasyGame;
  round: Round;
  pricing: RoundPricing;
  virtualBalance: number;
}): string {
  const secondsRemaining = Math.max(
    0,
    Math.floor((Date.parse(input.round.closingDate) - Date.now()) / 1000)
  );
  const mins = Math.floor(secondsRemaining / 60);
  const secs = secondsRemaining % 60;
  const countdown = `${mins}:${secs.toString().padStart(2, "0")}`;

  return [
    "🏆 BAYSE FANTASY ARENA — BTC 15mins ROUND",
    "",
    `League: ${input.game.code}`,
    `Closes in: ${countdown}`,
    `UP price: ${Math.round(input.pricing.upPrice * 100)}c`,
    `DOWN price: ${Math.round(input.pricing.downPrice * 100)}c`,
    `Virtual balance: ${formatMoney(input.virtualBalance)}`,
    "",
    "One fantasy trade per round.",
    "Choose your side and size:",
  ].join("\n");
}

function buildLeaderboardText(
  game: FantasyGame,
  leaderboard: FantasyLeaderboardEntry[]
): string {
  const prizePoolLines = buildPrizePoolLines(game.entry_fee, leaderboard.length);
  const rows =
    leaderboard.length === 0
      ? ["No players yet."]
      : leaderboard.slice(0, 10).map((entry) => {
          const name = entry.username
            ? `@${entry.username}`
            : `User${entry.telegram_id}`;
          return (
            `#${entry.place} ${name} - ${formatMoney(entry.virtual_balance)} ` +
            `(${entry.wins}W/${entry.losses}L, ${entry.accuracy_pct.toFixed(0)}%)`
          );
        });

  return [
    "🏆 ARENA STANDINGS",
    "",
    `League: ${game.code}`,
    `Status: ${game.status.toUpperCase()}`,
    ...prizePoolLines,
    `Starts: ${formatDateTime(game.start_at)}`,
    `Ends: ${formatDateTime(game.end_at)}`,
    "",
    ...rows,
  ].join("\n");
}

function buildRoundSettlementMessage(input: {
  game: FantasyGame;
  resolvedDirection: FantasyTradeDirection;
  trade: FantasyTrade | null;
  virtualBalance: number;
}): string {
  const lines = [
    `FANTASY ROUND RESOLVED - ${input.game.code}`,
    "",
    `Resolved side: ${formatResolvedDirection(input.resolvedDirection)}`,
  ];

  if (input.trade) {
    lines.push(
      `Your pick: ${input.trade.direction}`,
      `Stake: ${formatMoney(input.trade.stake)}`,
      `Result: ${input.trade.outcome}`
    );

    if (input.trade.outcome === "WIN" && input.trade.payout > 0) {
      lines.push(`Payout: ${formatMoney(input.trade.payout)}`);
    }
  } else {
    lines.push("You did not place a trade this round.");
  }

  lines.push(`Virtual balance: ${formatMoney(input.virtualBalance)}`);
  return lines.join("\n");
}

async function safeSendMessage(chatId: number, text: string, keyboard?: InlineKeyboard) {
  await tgApi
    .sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : undefined)
    .catch((error) => {
      console.warn(`[fantasy] Failed to send message to ${chatId}:`, error);
    });
}

export function getVirtualStartBalance(entryFee: number): number {
  return roundMoney(entryFee * FANTASY_ENTRY_MULTIPLIER);
}

export async function createFantasyLeagueGame(
  creatorTelegramId: number,
  entryFee: number
): Promise<FantasyGame> {
  const normalizedEntryFee = roundMoney(entryFee);

  if (
    !Number.isInteger(normalizedEntryFee) ||
    normalizedEntryFee < FANTASY_MIN_ENTRY_FEE ||
    normalizedEntryFee > FANTASY_MAX_ENTRY_FEE
  ) {
    throw new Error(
      `Entry fee must be a whole number between $${FANTASY_MIN_ENTRY_FEE} and $${FANTASY_MAX_ENTRY_FEE}.`
    );
  }

  const currentRound = await getCurrentRound(FANTASY_ASSET);

  if (!currentRound) {
    throw new Error("No open BTC 15M round found right now.");
  }

  const startAt = currentRound.closingDate;
  const endAt = new Date(Date.parse(startAt) + FANTASY_DURATION_MS).toISOString();
  const virtualStartBalance = getVirtualStartBalance(normalizedEntryFee);
  const code = await generateUniqueFantasyGameCode();
  const debited = await debitBalance(creatorTelegramId, normalizedEntryFee, {
    reason: "fantasy_entry_fee",
    referenceType: "fantasy_game",
    referenceId: code,
    metadata: {
      role: "creator",
      amount: normalizedEntryFee,
    },
  });

  if (!debited) {
    throw new Error(
      "Insufficient balance. Fund your fantasy balance before creating an arena."
    );
  }

  try {
    const game = await createFantasyGame({
      code,
      creatorTelegramId,
      entryFee: normalizedEntryFee,
      virtualStartBalance,
      startAt,
      endAt,
    });

    await addFantasyGameMember({
      gameId: game.id,
      telegramId: creatorTelegramId,
      entryFeePaid: normalizedEntryFee,
      virtualBalance: virtualStartBalance,
    });

    await recalculateFantasyPrizePool(game.id, FANTASY_COMMISSION_RATE);

    return (await getFantasyGameById(game.id)) ?? game;
  } catch (error) {
    await creditBalance(creatorTelegramId, normalizedEntryFee, {
      reason: "fantasy_refund",
      referenceType: "fantasy_game",
      referenceId: code,
      metadata: {
        role: "creator",
        amount: normalizedEntryFee,
      },
    }).catch(() => null);
    throw error;
  }
}

export async function joinFantasyLeagueGame(
  telegramId: number,
  code: string
): Promise<FantasyGame> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());

  if (!game) {
    throw new Error("Arena not found.");
  }

  if (game.status !== "open") {
    throw new Error("This arena has already started.");
  }

  if (Date.parse(game.start_at) <= Date.now()) {
    throw new Error("This arena has already started.");
  }

  const existingMember = await getFantasyGameMember(game.id, telegramId);

  if (existingMember) {
    throw new Error("You already joined this arena.");
  }

  const debited = await debitBalance(telegramId, game.entry_fee, {
    reason: "fantasy_entry_fee",
    referenceType: "fantasy_game",
    referenceId: game.code,
    metadata: {
      role: "member",
      amount: game.entry_fee,
    },
  });

  if (!debited) {
    throw new Error("Insufficient balance.");
  }

  try {
    await addFantasyGameMember({
      gameId: game.id,
      telegramId,
      entryFeePaid: game.entry_fee,
      virtualBalance: game.virtual_start_balance,
    });

    await recalculateFantasyPrizePool(game.id, FANTASY_COMMISSION_RATE);

    return (await getFantasyGameById(game.id)) ?? game;
  } catch (error) {
    await creditBalance(telegramId, game.entry_fee, {
      reason: "fantasy_refund",
      referenceType: "fantasy_game",
      referenceId: game.code,
      metadata: {
        role: "member",
        amount: game.entry_fee,
      },
    }).catch(() => null);
    throw error;
  }
}

export async function getFantasyLeagueJoinPreview(
  telegramId: number,
  code: string
): Promise<FantasyLeagueJoinPreview> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());

  if (!game) {
    throw new Error("Arena not found.");
  }

  if (game.status !== "open" || Date.parse(game.start_at) <= Date.now()) {
    throw new Error("This arena has already started.");
  }

  const existingMember = await getFantasyGameMember(game.id, telegramId);

  if (existingMember) {
    throw new Error("You already joined this arena.");
  }

  const leaderboard = await getFantasyLeaderboard(game.id);

  return {
    game,
    memberCount: leaderboard.length,
    projectedPrizePool: getPrizePoolBreakdown(
      game.entry_fee,
      leaderboard.length + 1
    ).netPrizePool,
  };
}

export async function getFantasyLeagueDetailsByCode(code: string): Promise<{
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  memberCount: number;
}> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());

  if (!game) {
    throw new Error("Arena not found.");
  }

  const leaderboard = await getFantasyLeaderboard(game.id);

  return {
    game,
    leaderboard,
    memberCount: leaderboard.length,
  };
}

export async function listFantasyLeagueSnapshots(
  telegramId: number
): Promise<FantasyGameSnapshot[]> {
  const games = await listUserFantasyGames(telegramId);
  const snapshots: FantasyGameSnapshot[] = [];

  for (const game of games.slice(0, 10)) {
    const leaderboard = await getFantasyLeaderboard(game.id);
    const me = leaderboard.find((entry) => entry.telegram_id === telegramId);

    snapshots.push({
      game,
      memberCount: leaderboard.length,
      yourRank: me?.place ?? null,
      yourVirtualBalance: me?.virtual_balance ?? null,
    });
  }

  return snapshots;
}

export async function activateDueFantasyGames(): Promise<void> {
  const dueGames = await listDueOpenFantasyGames(new Date().toISOString());

  for (const game of dueGames) {
    const members = await listFantasyGameMembers(game.id);
    await recalculateFantasyPrizePool(game.id, FANTASY_COMMISSION_RATE);

    await updateFantasyGame({
      gameId: game.id,
      status: "active",
    });

    const refreshed = (await getFantasyGameById(game.id)) ?? game;
    const leaderboard = await getFantasyLeaderboard(game.id);
    const message = [
      `🏆 BAYSE FANTASY ARENA ${refreshed.code} IS LIVE`,
      "",
      `Players: ${leaderboard.length}`,
      ...buildPrizePoolLines(refreshed.entry_fee, leaderboard.length),
      `Virtual bankroll: ${formatMoney(refreshed.virtual_start_balance)}`,
      "",
      "You will receive a fantasy BTC round prompt for each Bayse BTC 15M round over the next 24 hours.",
    ].join("\n");

    await Promise.all(
      members.map((member) => safeSendMessage(member.telegram_id, message))
    );
  }
}

export async function processFantasyLeagueRound(
  round: Round,
  pricing: RoundPricing
): Promise<void> {
  if (round.pctElapsed > FANTASY_ROUND_ALERT_MAX_PROGRESS) {
    return;
  }

  const activeGames = await listActiveFantasyGames(new Date().toISOString());

  for (const game of activeGames) {
    if (game.last_round_event_id === pricing.eventId) {
      continue;
    }

    const members = await listFantasyGameMembers(game.id);
    const keyboard = await buildFantasyTradeKeyboard({
      gameId: game.id,
      eventId: pricing.eventId,
      marketId: pricing.marketId,
    });

    await Promise.all(
      members.map((member) =>
        safeSendMessage(
          member.telegram_id,
          buildRoundBroadcastMessage({
            game,
            round,
            pricing,
            virtualBalance: member.virtual_balance,
          }),
          keyboard
        )
      )
    );

    await updateFantasyGame({
      gameId: game.id,
      lastRoundEventId: pricing.eventId,
    });
  }
}

export async function placeFantasyTradeFromCallbackData(input: {
  telegramId: number;
  callbackData: string;
}): Promise<FantasyTradePlacementResult> {
  const callbackData = input.callbackData;

  console.log(
    `[fantasy] placeFantasyTradeFromCallbackData entered with data: ${callbackData}`
  );

  const parts = callbackData.split(":");

  if (parts.length < 4 || parts[0] !== "flt" || parts[2] !== "r") {
    console.log(`[fantasy] Pre-throw state - all checks before Redis lookup`);
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const stake = roundMoney(Number.parseFloat(parts[1] ?? ""));
  const ref = parts.slice(3).join(":");

  if (!Number.isFinite(stake) || stake <= 0 || !ref) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const payload = await loadFantasyTradeReference(ref);

  if (!payload) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const game = await getFantasyGameById(payload.gameId);

  if (!game || game.status !== "active") {
    throw new Error("This league is not active right now.");
  }

  if (Date.parse(game.end_at) <= Date.now()) {
    throw new Error("This league has already ended.");
  }

  const member = await getFantasyGameMember(game.id, input.telegramId);

  if (!member) {
    throw new Error("You are not a member of this league.");
  }

  const existingTrade = await getFantasyTradeForMemberEvent(
    game.id,
    member.id,
    payload.eventId
  );

  if (existingTrade) {
    throw new Error("You already placed a fantasy trade for this round.");
  }

  const pricing = await getEventPricing(payload.eventId, payload.marketId);

  if (!pricing) {
    throw new Error("This fantasy round is no longer available.");
  }

  const entryPrice =
    payload.direction === "UP" ? pricing.upPrice : pricing.downPrice;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("Pricing is unavailable for this fantasy round.");
  }

  const debited = await debitFantasyBalance(member.id, stake);

  if (!debited) {
    throw new Error(
      `Insufficient virtual balance. Available: ${formatMoney(member.virtual_balance)}`
    );
  }

  try {
    const shares = stake / entryPrice;

    await recordFantasyTrade({
      gameId: game.id,
      memberId: member.id,
      telegramId: input.telegramId,
      eventId: payload.eventId,
      marketId: payload.marketId,
      direction: payload.direction,
      stake,
      entryPrice,
      shares,
    });

    await incrementFantasyMemberTradeCount(member.id).catch((error) => {
      console.warn(
        `[fantasy] Failed to increment trade count for ${member.id}:`,
        error
      );
    });

    const refreshedMember = await getFantasyGameMember(game.id, input.telegramId);

    return {
      game,
      stake,
      direction: payload.direction,
      entryPrice,
      shares,
      remainingBalance: refreshedMember?.virtual_balance ?? 0,
    };
  } catch (error) {
    await creditFantasyBalance(member.id, stake).catch(() => null);
    throw error;
  }
}

export async function settleFantasyLeagueTrades(): Promise<void> {
  const pendingTrades = await listPendingFantasyTrades();
  const eventCache = new Map<string, FantasyTradeDirection | null>();
  const tradesByRound = new Map<string, FantasyTrade[]>();

  for (const trade of pendingTrades) {
    const roundKey = `${trade.game_id}:${trade.event_id}`;
    const group = tradesByRound.get(roundKey) ?? [];
    group.push(trade);
    tradesByRound.set(roundKey, group);
  }

  for (const [roundKey, roundTrades] of tradesByRound) {
    const trade = roundTrades[0];

    if (!trade) {
      continue;
    }

    try {
      let resolvedDirection = eventCache.get(trade.event_id);

      if (resolvedDirection === undefined) {
        const event = await getEvent(trade.event_id);
        resolvedDirection = inferResolvedDirection(event);
        eventCache.set(trade.event_id, resolvedDirection);
      }

      if (!resolvedDirection) {
        continue;
      }

      const game = await getFantasyGameById(trade.game_id);

      if (!game) {
        continue;
      }

      let settlementFailed = false;

      for (const pendingTrade of roundTrades) {
        const outcome =
          resolvedDirection === pendingTrade.direction ? "WIN" : "LOSS";
        const payout = outcome === "WIN" ? roundMoney(pendingTrade.shares) : 0;

        try {
          const settledTrade = await settleFantasyTrade({
            tradeId: pendingTrade.id,
            outcome,
            payout,
          });

          if (!settledTrade) {
            continue;
          }

          await applyFantasyTradeSettlement(pendingTrade.member_id, {
            outcome,
            payout,
          });
        } catch (error) {
          settlementFailed = true;
          await reopenFantasyTradeSettlement({
            tradeId: pendingTrade.id,
            expectedOutcome: outcome,
          }).catch((rollbackError) => {
            console.error(
              `[fantasy] Failed to roll back fantasy trade ${pendingTrade.id}:`,
              rollbackError
            );
          });
          console.error(
            `[fantasy] Failed to settle fantasy trade ${pendingTrade.id}:`,
            error
          );
        }
      }

      if (settlementFailed) {
        continue;
      }

      const allTradesForRound = await listFantasyTradesForGameEvent(
        trade.game_id,
        trade.event_id
      );

      if (allTradesForRound.some((entry) => entry.outcome === "PENDING")) {
        continue;
      }

      const members = await listFantasyGameMembers(game.id);
      const tradesByMemberId = new Map(
        allTradesForRound.map((entry) => [entry.member_id, entry] as const)
      );

      await Promise.all(
        members.map((member) =>
          safeSendMessage(
            member.telegram_id,
            buildRoundSettlementMessage({
              game,
              resolvedDirection,
              trade: tradesByMemberId.get(member.id) ?? null,
              virtualBalance: member.virtual_balance,
            })
          )
        )
      );
    } catch (error) {
      console.error(
        `[fantasy] Failed to settle fantasy round ${roundKey}:`,
        error
      );
    }
  }
}

export async function finalizeFantasyGames(): Promise<void> {
  const dueGames = await listFinalizableFantasyGames(new Date().toISOString());

  for (const game of dueGames) {
    const pendingTrades = await listPendingFantasyTradesForGame(game.id);

    if (pendingTrades.length > 0) {
      continue;
    }

    const members = await listFantasyGameMembers(game.id);
    const netPrizePool = await recalculateFantasyPrizePool(
      game.id,
      FANTASY_COMMISSION_RATE
    );
    const settledGame =
      (await getFantasyGameById(game.id)) ??
      ({
        ...game,
        prize_pool: netPrizePool,
      } as FantasyGame);
    const leaderboard = await getFantasyLeaderboard(game.id);
    const breakdown = getPrizePoolBreakdown(game.entry_fee, members.length);
    const existingPayouts = await listFantasyPayouts(game.id);
    const paidTelegramIds = new Set(existingPayouts.map((entry) => entry.telegram_id));
    const splits = getPrizeSplits(leaderboard.length);
    let payoutFailed = false;

    for (const winner of leaderboard.slice(0, splits.length)) {
      if (paidTelegramIds.has(winner.telegram_id)) {
        continue;
      }

      const share = splits[winner.place - 1] ?? 0;
      const amount = roundMoney(settledGame.prize_pool * share);

      if (amount <= 0) {
        continue;
      }

      const member = await getFantasyGameMember(game.id, winner.telegram_id);

      if (!member) {
        continue;
      }

      try {
        const awarded = await awardFantasyPrize({
          gameId: game.id,
          memberId: member.id,
          telegramId: winner.telegram_id,
          place: winner.place,
          amount,
        });

        if (!awarded) {
          continue;
        }

        await creditBalance(winner.telegram_id, amount, {
          reason: "fantasy_prize",
          referenceType: "fantasy_game",
          referenceId: game.code,
          metadata: {
            place: winner.place,
            amount,
          },
        });
      } catch (error) {
        payoutFailed = true;
        await revokeFantasyPrize({
          gameId: game.id,
          telegramId: winner.telegram_id,
        }).catch((rollbackError) => {
          console.error(
            `[fantasy] Failed to roll back prize claim for ${game.code}/${winner.telegram_id}:`,
            rollbackError
          );
        });
        console.error(
          `[fantasy] Failed to award prize for ${game.code}/${winner.telegram_id}:`,
          error
        );
      }
    }

    if (payoutFailed) {
      continue;
    }

    await syncFantasyPrizeAwards(game.id);

    const refreshedLeaderboard = await getFantasyLeaderboard(game.id);
    const winnerLines = refreshedLeaderboard
      .slice(0, splits.length)
      .map((entry) => {
        const share = splits[entry.place - 1] ?? 0;
        const payout = roundMoney(settledGame.prize_pool * share);
        const name = entry.username
          ? `@${entry.username}`
          : `User${entry.telegram_id}`;
        return `#${entry.place} ${name} - ${formatMoney(payout)}`;
      });

    await recordRevenueOnce({
      telegramId: game.creator_telegram_id,
      type: `fantasy_commission:${game.code}`,
      amount: breakdown.commissionAmount,
    });

    await updateFantasyGame({
      gameId: game.id,
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    const completedGame = ((await getFantasyGameById(game.id)) ?? {
      ...game,
      status: "completed",
      completed_at: new Date().toISOString(),
    }) as FantasyGame;

    const finalMessage = [
      "🏆 ARENA COMPLETE",
      "",
      `League: ${game.code}`,
      "Winners:",
      ...(winnerLines.length > 0 ? winnerLines : ["No winners."]),
      "",
      buildLeaderboardText(completedGame, refreshedLeaderboard),
    ].join("\n");

    await Promise.all(
      members.map((member) => safeSendMessage(member.telegram_id, finalMessage))
    );
  }
}

export async function getFantasyLeagueBoardText(code: string): Promise<string> {
  const { game, leaderboard } = await getFantasyLeagueDetailsByCode(code);
  return buildLeaderboardText(game, leaderboard);
}

export async function getFantasyLeagueJoinSummary(
  code: string
): Promise<string> {
  const { game, leaderboard } = await getFantasyLeagueDetailsByCode(code);

  return [
    "🏆 BAYSE FANTASY ARENA",
    "",
    `League Code: ${game.code}`,
    `Asset: ${game.asset}`,
    `Entry Fee: ${formatMoney(game.entry_fee)}`,
    `Virtual Funds: ${formatMoney(game.virtual_start_balance)}`,
    `Prize Pool: ${formatMoney(game.prize_pool)}`,
    `Players joined: ${leaderboard.length}`,
    "Duration: 24 hours",
    `Starts: ${formatDateTime(game.start_at)}`,
    `Ends: ${formatDateTime(game.end_at)}`,
    "",
    "Joining is final. No refunds after you join.",
  ].join("\n");
}
