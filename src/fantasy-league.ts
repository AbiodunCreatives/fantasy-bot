import { Api, InlineKeyboard } from "grammy";

import {
  getEventPricing,
  getEvent,
  getNextRoundStart,
  getTradeQuote,
  type Round,
  type RoundPricing,
} from "./bayse-market.ts";
import { config } from "./config.ts";
import { getBalance, creditBalance } from "./db/balances.ts";
import {
  applyFantasyTradeSettlement,
  awardFantasyPrize,
  createFantasyGameWithEntry,
  getFantasyGameByCode,
  getFantasyGameById,
  getFantasyGameMember,
  getFantasyLeaderboard,
  getLatestFantasyTradeForMember,
  getFantasyTradeForMemberEvent,
  joinFantasyGameWithEntry,
  listActiveFantasyGames,
  listDueOpenFantasyGames,
  listFantasyGameMembers,
  listFantasyPayouts,
  listFantasyTradesForGame,
  listFinalizableFantasyGames,
  listOpenFantasyGames,
  listPendingFantasyTrades,
  listFantasyTradesForGameEvent,
  listPendingFantasyTradesForGame,
  listUserFantasyGames,
  placeFantasyTradeWithDebit,
  recalculateFantasyPrizePool,
  reopenFantasyTradeSettlement,
  revokeFantasyPrize,
  settleFantasyTrade,
  syncFantasyPrizeAwards,
  updateFantasyGame,
  type FantasyGame,
  type FantasyLeaderboardEntry,
  type FantasyTrade,
  type FantasyTradeDirection,
} from "./db/fantasy.ts";
import { upsertUserProfile } from "./db/users.ts";
import {
  ARENA_DURATION_HOURS_OPTIONS,
  anonymizePlayer,
  buildShareResultUrl,
  formatDurationHours,
  formatBtcPrice,
  formatCompactDuration,
  getGameDurationHours,
  formatMediumDateTime,
  formatMoney,
  formatProbabilityPrice,
  formatRankMovement,
  formatRoundCountdown,
  formatSignedPercent,
  formatWholeMoney,
  getApproxRoundsLeft,
  getApproxRoundsUntil,
  getGameRoundNumber,
  getPrizeAwardPreview,
  getProjectedPrizeForUser,
  getVirtualReturnPct,
} from "./fantasy-ui.ts";
import { recordRevenueOnce } from "./db/revenue.ts";
import { redis } from "./utils/rateLimit.ts";

const tgApi = new Api(config.BOT_TOKEN);
let cachedBotUsername: string | null = null;

export const FANTASY_ASSET = "BTC" as const;
export const FANTASY_ENTRY_MULTIPLIER = 100;
export const FANTASY_COMMISSION_RATE = 0.08;
export const FANTASY_MIN_ENTRY_FEE = 1;
export const FANTASY_MAX_ENTRY_FEE = 10;
export const FANTASY_TRADE_AMOUNTS = [10, 25, 50, 100] as const;
export const FANTASY_DEFAULT_DURATION_HOURS = 24;
const FANTASY_JOIN_PENDING_TTL_SECONDS = 5 * 60;
const FANTASY_TRADE_REF_TTL_SECONDS = 15 * 60;
const FANTASY_MISSED_STREAK_ALERT = 3;
const FANTASY_CUSTOM_FUND_TTL_SECONDS = 10 * 60;
const FANTASY_NEXT_ROUND_REMINDER_TTL_SECONDS = 2 * 60 * 60;

interface FantasyTradeRefPayload {
  gameId: string;
  eventId: string;
  marketId: string;
  openingDate: string;
  closingDate: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
  upOutcomeId: string | null;
  downOutcomeId: string | null;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getOutcomeIdForDirection(
  direction: FantasyTradeDirection,
  payload: Pick<FantasyTradeRefPayload, "upOutcomeId" | "downOutcomeId">,
  pricing?: Pick<RoundPricing, "upOutcomeId" | "downOutcomeId">
): string | null {
  const direct =
    direction === "UP"
      ? payload.upOutcomeId ?? pricing?.upOutcomeId
      : payload.downOutcomeId ?? pricing?.downOutcomeId;

  return typeof direct === "string" && direct.trim() ? direct : null;
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
  projectedFirstPrize: number;
  currentLeaderName: string | null;
  currentLeaderReturnPct: number | null;
}

export interface FantasyTradePlacementResult {
  game: FantasyGame;
  stake: number;
  direction: FantasyTradeDirection;
  roundNumber: number;
  entryPrice: number;
  shares: number;
  remainingBalance: number;
  stackIfWin: number;
  stackIfLoss: number;
  closesAt: string;
}

export interface FantasyArenaLobbyCard {
  game: FantasyGame;
  memberCount: number;
  state: "LIVE" | "FILLING" | "OPEN";
  topLeaderName: string | null;
  topLeaderReturnPct: number | null;
}

export interface FantasyArenaLobbySnapshot {
  live: FantasyArenaLobbyCard[];
  filling: FantasyArenaLobbyCard[];
  open: FantasyArenaLobbyCard[];
}

export interface FantasyLeagueStatusView {
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  memberCount: number;
  me: FantasyLeaderboardEntry | null;
  prizeIfEndedNow: number;
  roundsLeft: number;
  roundsPlayed: number;
  lastTrade: FantasyTrade | null;
}

export interface FantasyTradeStakeSelectionView {
  game: FantasyGame;
  direction: FantasyTradeDirection;
  directionPrice: number;
  roundNumber: number;
  closesAt: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
}

interface PromptState {
  game: FantasyGame;
  telegramId: number;
  messageId: number;
  chatId: number;
  memberCount: number;
  rank: number;
  virtualBalance: number;
  roundNumber: number;
  closingDate: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
  ref: string;
  stage: "direction" | "stake";
  selectedDirection: FantasyTradeDirection | null;
  selectedStake: number | null;
}

const activePromptStates = new Map<string, PromptState>();
const activePromptTimers = new Map<string, NodeJS.Timeout>();

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getFantasyDurationMs(durationHours: number): number {
  return durationHours * 60 * 60 * 1000;
}

function normalizeFantasyDurationHours(durationHours: number): number {
  const normalizedHours = Math.round(durationHours);

  if (
    !Number.isInteger(normalizedHours) ||
    !ARENA_DURATION_HOURS_OPTIONS.includes(
      normalizedHours as (typeof ARENA_DURATION_HOURS_OPTIONS)[number]
    )
  ) {
    throw new Error(
      `Duration must be one of ${ARENA_DURATION_HOURS_OPTIONS
        .map((hours) => formatDurationHours(hours))
        .join(", ")}.`
    );
  }

  return normalizedHours;
}

async function getBotUsername(): Promise<string> {
  if (cachedBotUsername) {
    return cachedBotUsername;
  }

  const me = await tgApi.getMe();
  cachedBotUsername = me.username;
  return cachedBotUsername;
}

function shortCode(): string {
  const left = Math.random().toString(36).slice(2, 5).toUpperCase();
  const right = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${left}-${right}`;
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

function fantasyMissedStreakKey(gameId: string, telegramId: number): string {
  return `fantasy:missed:${gameId}:${telegramId}`;
}

function fantasyCustomFundKey(telegramId: number): string {
  return `fantasy:fund:custom:${telegramId}`;
}

function fantasyRoundReminderKey(gameId: string, telegramId: number): string {
  return `fantasy:remind:${gameId}:${telegramId}`;
}

function promptStateKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

async function saveFantasyTradeReference(
  payload: FantasyTradeRefPayload
): Promise<string> {
  const ref = `${payload.gameId}:${payload.eventId}:${payload.marketId}`
    .replace(/[^a-zA-Z0-9:]/g, "")
    .slice(0, 32);
  const uniqueRef = `${ref}:${Date.now().toString(36)}`.slice(0, 48);
  const redisKey = fantasyTradeRefKey(uniqueRef);

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

export async function savePendingFantasyCustomFundAmount(
  telegramId: number
): Promise<void> {
  await redis.set(
    fantasyCustomFundKey(telegramId),
    "1",
    "EX",
    FANTASY_CUSTOM_FUND_TTL_SECONDS
  );
}

export async function hasPendingFantasyCustomFundAmount(
  telegramId: number
): Promise<boolean> {
  return Boolean(await redis.get(fantasyCustomFundKey(telegramId)));
}

export async function clearPendingFantasyCustomFundAmount(
  telegramId: number
): Promise<void> {
  await redis.del(fantasyCustomFundKey(telegramId));
}

export async function addFantasyPlayBalance(
  telegramId: number,
  amount: number
): Promise<number> {
  const normalizedAmount = roundMoney(amount);

  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Top-up amount must be greater than zero.");
  }

  await creditBalance(telegramId, normalizedAmount, {
    reason: "fantasy_top_up",
    referenceType: "fantasy_balance",
    metadata: {
      amount: normalizedAmount,
    },
  });

  return getBalance(telegramId);
}

export async function saveFantasyNextRoundReminder(
  telegramId: number,
  code: string
): Promise<boolean> {
  const game = await getFantasyGameByCode(code.trim().toUpperCase());

  if (!game) {
    return false;
  }

  const member = await getFantasyGameMember(game.id, telegramId);

  if (!member) {
    return false;
  }

  await redis.set(
    fantasyRoundReminderKey(game.id, telegramId),
    "1",
    "EX",
    FANTASY_NEXT_ROUND_REMINDER_TTL_SECONDS
  );

  return true;
}

async function consumeFantasyNextRoundReminder(
  gameId: string,
  telegramId: number
): Promise<boolean> {
  const deleted = await redis.del(fantasyRoundReminderKey(gameId, telegramId));
  return deleted > 0;
}

async function loadFantasyTradeReference(
  ref: string
): Promise<FantasyTradeRefPayload | null> {
  const redisKey = fantasyTradeRefKey(ref);
  const cached = await redis.get(redisKey);

  if (!cached) {
    return null;
  }

  try {
    const parsed = JSON.parse(cached) as FantasyTradeRefPayload & {
      currentPrice?: unknown;
    };

    if (
      !parsed.gameId ||
      !parsed.eventId ||
      !parsed.marketId ||
      !parsed.openingDate ||
      !parsed.closingDate ||
      !Number.isFinite(parsed.upPrice) ||
      !Number.isFinite(parsed.downPrice) ||
      !isOptionalString(parsed.upOutcomeId) ||
      !isOptionalString(parsed.downOutcomeId)
    ) {
      return null;
    }

    return {
      ...parsed,
      currentPrice: parseOptionalNumber(parsed.currentPrice),
    };
  } catch {
    return null;
  }
}

function buildFantasyTradeDirectionButtonData(
  direction: FantasyTradeDirection,
  ref: string
): string {
  return `flt:b:${direction}:r:${ref}`;
}

function buildFantasyTradeStakeButtonData(
  amount: number,
  direction: FantasyTradeDirection,
  ref: string
): string {
  return `flt:d:${amount}:${direction}:r:${ref}`;
}

function buildFantasyTradeDirectionKeyboard(input: {
  amount?: number;
  ref: string;
  upPrice: number;
  downPrice: number;
}): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `⬆ UP (${formatProbabilityPrice(input.upPrice)})`,
      buildFantasyTradeDirectionButtonData("UP", input.ref)
    )
    .text(
      `⬇ DOWN (${formatProbabilityPrice(input.downPrice)})`,
      buildFantasyTradeDirectionButtonData("DOWN", input.ref)
    );
}

function buildFantasyTradeBuyKeyboard(input: {
  ref: string;
  upPrice: number;
  downPrice: number;
}): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `Buy YES (${formatRoundPromptPrice(input.upPrice)}c)`,
      buildFantasyTradeDirectionButtonData("UP", input.ref)
    )
    .text(
      `Buy NO (${formatRoundPromptPrice(input.downPrice)}c)`,
      buildFantasyTradeDirectionButtonData("DOWN", input.ref)
    );
}

function buildFantasyTradeStakeKeyboard(input: {
  direction: FantasyTradeDirection;
  ref: string;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  FANTASY_TRADE_AMOUNTS.forEach((amount, index) => {
    keyboard.text(
      `${amount} USDC`,
      buildFantasyTradeStakeButtonData(amount, input.direction, input.ref)
    );

    if (index % 2 === 1 && index < FANTASY_TRADE_AMOUNTS.length - 1) {
      keyboard.row();
    }
  });

  return keyboard;
}

function clearPromptTimer(key: string): void {
  const timer = activePromptTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    activePromptTimers.delete(key);
  }
}

function clearPromptState(key: string): void {
  clearPromptTimer(key);
  activePromptStates.delete(key);
}

function formatRoundPromptBtcTarget(value: number | null): string {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${(value ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRoundPromptChance(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return String(Math.round(value * 100));
}

function formatRoundPromptPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return String(Math.round(value * 100));
}

function formatRoundPromptMultiplier(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0.0";
  }

  return (1 / value).toFixed(1);
}

function formatRoundPromptBalanceDelta(game: FantasyGame, virtualBalance: number): string {
  const returnPct = getVirtualReturnPct(game, virtualBalance);
  const rounded = Math.round((returnPct + Number.EPSILON) * 10) / 10;
  const prefix = rounded >= 0 ? "+" : "";
  return `${prefix}${rounded.toFixed(1)}`;
}

function getProjectedPrizeForRank(rank: number, memberCount: number, prizePool: number): number {
  const split = getPrizeSplits(memberCount)[rank - 1] ?? 0;
  return roundMoney(prizePool * split);
}

function buildRoundPromptText(state: PromptState): string {
  const yesChance = formatRoundPromptChance(state.upPrice).padStart(3, " ");
  const noChance = formatRoundPromptChance(state.downPrice).padStart(3, " ");
  const yesPrice = formatRoundPromptPrice(state.upPrice).padStart(3, " ");
  const noPrice = formatRoundPromptPrice(state.downPrice).padStart(3, " ");
  const arenaTimeLeft = formatCompactDuration(
    Math.max(0, Date.parse(state.game.end_at) - Date.now())
  );

  return [
    "━━━━━━━━━━━━━━━━━━",
    `⚡ ROUND ${state.roundNumber}  •  LIVE`,
    "━━━━━━━━━━━━━━━━━━",
    `📍 BTC target: ${formatRoundPromptBtcTarget(state.referencePrice)}`,
    "",
    `⬆ YES   ${yesChance}%   ${yesPrice}¢   wins ${formatRoundPromptMultiplier(state.upPrice)}×`,
    `⬇ NO    ${noChance}%   ${noPrice}¢   wins ${formatRoundPromptMultiplier(
      state.downPrice
    )}×`,
    "",
    "━━━━━━━━━━━━━━━━━━",
    `🏆 Rank #${state.rank}  •  Stack ${formatWholeMoney(state.virtualBalance)} (${formatRoundPromptBalanceDelta(
      state.game,
      state.virtualBalance
    )}%)`,
    `💰 Prize now: ${formatMoney(
      getProjectedPrizeForRank(state.rank, state.memberCount, state.game.prize_pool)
    )}`,
    `⏱ Round: ${formatRoundCountdown(state.closingDate)}  •  Arena: ${arenaTimeLeft}`,
  ].join("\n");

  return [
    `⚡ ROUND ${state.roundNumber}  •  Arena ${state.game.code}`,
    "",
    `BTC/USD: ${formatBtcPrice(state.referencePrice)}`,
    `↑ UP  ${formatProbabilityPrice(state.upPrice)}   •   ↓ DOWN  ${formatProbabilityPrice(
      state.downPrice
    )}`,
    "",
    `Your stack: ${formatWholeMoney(state.virtualBalance)}  (${formatSignedPercent(
      getVirtualReturnPct(state.game, state.virtualBalance)
    )})`,
    `Your rank: #${state.rank} of ${state.memberCount}`,
    "",
    state.stage === "direction" && state.selectedStake
      ? `Stake ${formatWholeMoney(state.selectedStake ?? 0)} - which direction?`
      : "Pick a stake:",
    "",
    `⏱ ${formatRoundCountdown(state.closingDate)} remaining`,
  ].join("\n");
}

function buildRoundPromptKeyboard(state: PromptState): InlineKeyboard {
  return state.stage === "stake" && state.selectedDirection !== null
    ? buildFantasyTradeStakeKeyboard({
        direction: state.selectedDirection,
        ref: state.ref,
      })
    : buildFantasyTradeBuyKeyboard({
        ref: state.ref,
        upPrice: state.upPrice,
        downPrice: state.downPrice,
      });
}

function buildClosedPromptText(state: PromptState): string {
  return [
    `Round ${state.roundNumber} is closed in Arena ${state.game.code}.`,
    "",
    state.stage === "stake" && state.selectedDirection !== null
      ? `Your ${formatFantasyTradeDirection(state.selectedDirection)} order did not lock before the bell.`
      : "No trade was locked for this round.",
    "No problem. I will send the next BTC prompt shortly.",
  ].join("\n");
}

function formatLiveRoundPromptBtcPrice(value: number | null): string {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${(value ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatLiveRoundPromptSignedMoney(value: number): string {
  const rounded = roundMoney(value);
  const prefix = rounded >= 0 ? "+" : "-";

  return `${prefix}$${Math.abs(rounded).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function getFantasyDirectionPrice(
  direction: FantasyTradeDirection,
  upPrice: number,
  downPrice: number
): number {
  return direction === "UP" ? upPrice : downPrice;
}

function getFantasyProjectedPayout(price: number, amount: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    return 0;
  }

  return roundMoney(amount / price);
}

function getFantasyProjectedProfit(price: number, amount: number): number {
  return roundMoney(getFantasyProjectedPayout(price, amount) - amount);
}

function formatFantasyTradeDirection(direction: FantasyTradeDirection): string {
  return direction === "UP" ? "Buy YES" : "Buy NO";
}

function buildLiveRoundQuestion(referencePrice: number | null): string {
  if (!Number.isFinite(referencePrice)) {
    return "Will Bitcoin finish above the Bayse target when this round closes?";
  }

  return `Will Bitcoin be above ${formatLiveRoundPromptBtcPrice(
    referencePrice
  )} when this round closes?`;
}

function buildLiveRoundPromptText(state: PromptState): string {
  const yesChance = formatRoundPromptChance(state.upPrice).padStart(3, " ");
  const noChance = formatRoundPromptChance(state.downPrice).padStart(3, " ");
  const yesPrice = formatRoundPromptPrice(state.upPrice).padStart(3, " ");
  const noPrice = formatRoundPromptPrice(state.downPrice).padStart(3, " ");
  const arenaTimeLeft = formatCompactDuration(
    Math.max(0, Date.parse(state.game.end_at) - Date.now())
  );
  const selectedPrice =
    state.selectedDirection === null
      ? null
      : getFantasyDirectionPrice(state.selectedDirection, state.upPrice, state.downPrice);
  const stageLines =
    state.stage === "stake" && state.selectedDirection !== null && selectedPrice !== null
      ? [
          `${formatFantasyTradeDirection(state.selectedDirection)} selected at ${formatRoundPromptPrice(
            selectedPrice
          )}c.`,
          `If you're right: win ${formatLiveRoundPromptSignedMoney(
            getFantasyProjectedProfit(selectedPrice, 100)
          )} on $100.`,
          "How many USDC do you want to play?",
        ]
      : ["Tap Buy YES or Buy NO first, then choose how many USDC to play."];

  return [
    "------------------",
    `ROUND ${state.roundNumber}  |  LIVE`,
    "------------------",
    buildLiveRoundQuestion(state.referencePrice),
    "",
    `Current price: ${formatLiveRoundPromptBtcPrice(state.currentPrice)}`,
    `Target price: ${formatLiveRoundPromptBtcPrice(state.referencePrice)}`,
    "",
    `Buy YES   ${yesChance}%   ${yesPrice}c   wins ${formatLiveRoundPromptSignedMoney(
      getFantasyProjectedProfit(state.upPrice, 100)
    )} on $100`,
    `Buy NO    ${noChance}%   ${noPrice}c   wins ${formatLiveRoundPromptSignedMoney(
      getFantasyProjectedProfit(state.downPrice, 100)
    )} on $100`,
    "",
    `Rank #${state.rank}  |  Stack ${formatWholeMoney(state.virtualBalance)} (${formatRoundPromptBalanceDelta(
      state.game,
      state.virtualBalance
    )}%)`,
    `Round: ${formatRoundCountdown(state.closingDate)}  |  Arena: ${arenaTimeLeft}`,
    "",
    ...stageLines,
  ].join("\n");
}

async function closePromptMessage(key: string): Promise<void> {
  const state = activePromptStates.get(key);

  if (!state) {
    return;
  }

  clearPromptState(key);

  try {
    await tgApi.editMessageText(state.chatId, state.messageId, buildClosedPromptText(state), {
      reply_markup: new InlineKeyboard(),
    });
  } catch (error) {
    console.warn("[fantasy] Failed to close prompt message:", error);
  }
}

async function refreshPromptMessage(key: string): Promise<void> {
  const state = activePromptStates.get(key);

  if (!state) {
    return;
  }

  if (Date.parse(state.closingDate) <= Date.now()) {
    await closePromptMessage(key);
    return;
  }

  try {
    await tgApi.editMessageText(
      state.chatId,
      state.messageId,
      buildLiveRoundPromptText(state),
      { reply_markup: buildRoundPromptKeyboard(state) }
    );
  } catch (error) {
    console.warn("[fantasy] Failed to refresh prompt countdown:", error);
    clearPromptState(key);
    return;
  }

  const msRemaining = Date.parse(state.closingDate) - Date.now();

  if (msRemaining <= 0) {
    clearPromptState(key);
    return;
  }

  const timer = setTimeout(() => {
    void refreshPromptMessage(key);
  }, Math.min(60_000, msRemaining));

  activePromptTimers.set(key, timer);
}

function schedulePromptCountdown(state: PromptState): void {
  const key = promptStateKey(state.chatId, state.messageId);
  activePromptStates.set(key, state);
  clearPromptTimer(key);

  const msRemaining = Date.parse(state.closingDate) - Date.now();

  if (msRemaining <= 0) {
    clearPromptState(key);
    return;
  }

  const timer = setTimeout(() => {
    void refreshPromptMessage(key);
  }, Math.min(60_000, msRemaining));

  activePromptTimers.set(key, timer);
}

function getPromptStateFromMessage(
  chatId: number | undefined,
  messageId: number | undefined
): { key: string; state: PromptState } | null {
  if (chatId === undefined || messageId === undefined) {
    return null;
  }

  const key = promptStateKey(chatId, messageId);
  const state = activePromptStates.get(key);

  if (!state) {
    return null;
  }

  return { key, state };
}

async function buildTradeReference(input: {
  gameId: string;
  eventId: string;
  marketId: string;
  openingDate: string;
  closingDate: string;
  currentPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
  upOutcomeId: string | null;
  downOutcomeId: string | null;
}): Promise<string> {
  return saveFantasyTradeReference({
    gameId: input.gameId,
    eventId: input.eventId,
    marketId: input.marketId,
    openingDate: input.openingDate,
    closingDate: input.closingDate,
    currentPrice: input.currentPrice,
    referencePrice: input.referencePrice,
    upPrice: input.upPrice,
    downPrice: input.downPrice,
    upOutcomeId: input.upOutcomeId,
    downOutcomeId: input.downOutcomeId,
  });
}

async function getRoundCurrentPrice(pricing: RoundPricing): Promise<number | null> {
  const outcomeId = pricing.upOutcomeId ?? pricing.downOutcomeId;

  if (!outcomeId) {
    return null;
  }

  try {
    const quote = await getTradeQuote({
      eventId: pricing.eventId,
      marketId: pricing.marketId,
      outcomeId,
      amount: FANTASY_TRADE_AMOUNTS[0],
      currency: "USD",
    });

    return parseOptionalNumber(quote?.currentMarketPrice);
  } catch (error) {
    console.warn(
      `[fantasy] Failed to load current BTC price for ${pricing.eventId}:`,
      error
    );
    return null;
  }
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

function getArenaLobbyState(
  game: FantasyGame,
  memberCount: number
): "LIVE" | "FILLING" | "OPEN" {
  if (game.status === "active" && Date.parse(game.end_at) > Date.now()) {
    return "LIVE";
  }

  if (game.status === "open" && memberCount > 1) {
    return "FILLING";
  }

  return "OPEN";
}

function getFirstPrizeProjection(prizePool: number, playerCount: number): number {
  const preview = getPrizeAwardPreview(
    Array.from({ length: Math.max(1, playerCount) }, (_, index) => ({
      place: index + 1,
      telegram_id: index + 1,
      username: null,
      virtual_balance: 0,
      wins: 0,
      losses: 0,
      total_trades: 0,
      accuracy_pct: 0,
      prize_awarded: 0,
      joined_at: new Date(0).toISOString(),
    })),
    prizePool
  );

  return preview[0]?.amount ?? 0;
}

function countRoundsPlayed(trades: FantasyTrade[]): number {
  return new Set(trades.map((trade) => trade.event_id)).size;
}

function formatResolvedDirection(direction: FantasyTradeDirection): string {
  return direction === "UP" ? "⬆ UP" : "⬇ DOWN";
}

function buildRoundBroadcastMessage(input: {
  game: FantasyGame;
  round: Round;
  pricing: RoundPricing;
  rank: number;
  memberCount: number;
  virtualBalance: number;
  ref: string;
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
    `Starts: ${formatMediumDateTime(game.start_at)}`,
    `Ends: ${formatMediumDateTime(game.end_at)}`,
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

async function safeSendMessageAndReturn(
  chatId: number,
  text: string,
  keyboard?: InlineKeyboard
) {
  return tgApi
    .sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : undefined)
    .catch((error) => {
      console.warn(`[fantasy] Failed to send message to ${chatId}:`, error);
      return null;
    });
}

function buildRoundBroadcastPayload(input: {
  game: FantasyGame;
  round: Round;
  pricing: RoundPricing;
  currentPrice: number | null;
  rank: number;
  memberCount: number;
  virtualBalance: number;
  ref: string;
}): { text: string; keyboard: InlineKeyboard; state: PromptState } {
  const state: PromptState = {
    game: input.game,
    telegramId: 0,
    messageId: 0,
    chatId: 0,
    memberCount: input.memberCount,
    rank: input.rank,
    virtualBalance: input.virtualBalance,
    roundNumber: getGameRoundNumber(input.game, input.round.openingDate),
    closingDate: input.round.closingDate,
    currentPrice: input.currentPrice,
    referencePrice: input.pricing.eventThreshold,
    upPrice: input.pricing.upPrice,
    downPrice: input.pricing.downPrice,
    ref: input.ref,
    stage: "direction",
    selectedDirection: null,
    selectedStake: null,
  };

  return {
    text: buildLiveRoundPromptText(state),
    keyboard: buildRoundPromptKeyboard(state),
    state,
  };
}

function renderLeaderboardText(input: {
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  viewerTelegramId: number;
}): string {
  const viewerEntry =
    input.leaderboard.find((entry) => entry.telegram_id === input.viewerTelegramId) ?? null;
  const timingLine =
    input.game.status === "completed" || input.game.status === "cancelled"
      ? `Ended: ${formatMediumDateTime(input.game.completed_at ?? input.game.end_at)}`
      : input.game.status === "open"
        ? `Starts: ${formatMediumDateTime(input.game.start_at)}`
        : `Ends in: ${formatCompactDuration(Date.parse(input.game.end_at) - Date.now())}`;
  const summaryLine =
    input.game.status === "completed" || input.game.status === "cancelled"
      ? `Your payout prize - ${formatMoney(viewerEntry?.prize_awarded ?? 0)}`
      : `Prize if game ended now: ${formatMoney(
          getProjectedPrizeForUser(
            input.leaderboard,
            input.game.prize_pool,
            input.viewerTelegramId
          )
        )}`;
  const rows =
    input.leaderboard.length === 0
      ? ["No players yet."]
      : input.leaderboard.slice(0, 10).map((entry, index) => {
          const name = anonymizePlayer(entry.telegram_id, input.viewerTelegramId);
          const badges =
            index === 0
              ? "  🔥"
              : entry.virtual_balance < input.game.virtual_start_balance
                ? "  📉"
                : entry.telegram_id === input.viewerTelegramId
                  ? "  ↑"
                  : "";

          return (
            `${entry.place}.  ${name.padEnd(8)} ${formatWholeMoney(entry.virtual_balance)}   ` +
            `${formatSignedPercent(
              getVirtualReturnPct(input.game, entry.virtual_balance)
            )}${badges}`
          );
        });

  return [
    `🏆 Arena ${input.game.code}  •  ${
      input.game.status === "active" ? "LIVE" : input.game.status.toUpperCase()
    }`,
    "",
    timingLine,
    `Net prize pool: ${formatMoney(input.game.prize_pool)}`,
    "",
    ...rows,
    "",
    summaryLine,
  ].join("\n");
}

function buildFinalArenaMessage(input: {
  game: FantasyGame;
  leaderboard: FantasyLeaderboardEntry[];
  viewerTelegramId: number;
  roundsPlayed: number;
}): string {
  const standings = input.leaderboard.map((entry) => {
    const medal =
      entry.place === 1 ? "🥇" : entry.place === 2 ? "🥈" : entry.place === 3 ? "🥉" : "  ";
    const name = anonymizePlayer(entry.telegram_id, input.viewerTelegramId);
    const payoutText =
      entry.prize_awarded > 0 ? formatMoney(entry.prize_awarded) : "—";

    return (
      `${medal}  ${name.padEnd(8)} ${formatWholeMoney(entry.virtual_balance)}   ` +
      `${formatSignedPercent(
        getVirtualReturnPct(input.game, entry.virtual_balance)
      )}   → ${payoutText}`
    );
  });
  const me =
    input.leaderboard.find((entry) => entry.telegram_id === input.viewerTelegramId) ??
    null;
  const payout = me?.prize_awarded ?? 0;

  return [
    `🏁 Arena ${input.game.code} — FINAL`,
    "",
    `Duration: ${formatDurationHours(getGameDurationHours(input.game))}  •  ${input.roundsPlayed} rounds played`,
    "",
    ...standings,
    "",
    payout > 0 ? `Your payout: ${formatMoney(payout)} ✅` : "Your payout: —",
    payout > 0 ? "Added to your balance." : "No payout this time.",
  ].join("\n");
}

function renderRoundSettlementMessage(input: {
  game: FantasyGame;
  roundNumber: number;
  resolvedDirection: FantasyTradeDirection;
  trade: FantasyTrade | null;
  previousRank: number | null;
  nextRank: number;
  nextLeaderName: string | null;
  previousBalance: number;
  virtualBalance: number;
  prizeIfEndedNow: number;
}): string {
  const lines = [`Round ${input.roundNumber} result: ${formatResolvedDirection(input.resolvedDirection)} ✅`, ""];

  if (input.trade) {
    if (input.trade.outcome === "WIN") {
      lines.push(
        `Your trade: ${formatWholeMoney(input.trade.stake)} ${input.trade.direction} - WON`,
        `Payout: +${formatMoney(input.trade.payout)}`,
        `Stack: ${formatWholeMoney(input.previousBalance)} → ${formatMoney(
          input.virtualBalance
        )}`
      );
    } else {
      lines.push(
        `Your trade: ${formatWholeMoney(input.trade.stake)} ${input.trade.direction} - LOST`,
        `Stack: ${formatWholeMoney(input.previousBalance)} → ${formatMoney(
          input.virtualBalance
        )}`
      );
    }
  } else {
    lines.push(
      `Round ${input.roundNumber} closed  •  Result: ${formatResolvedDirection(
        input.resolvedDirection
      )}`,
      "",
      "You sat this one out.",
      `Stack: ${formatWholeMoney(input.virtualBalance)} (unchanged)`
    );
  }

  if (!input.trade && input.nextLeaderName) {
    lines.push("", `${input.nextLeaderName} is now ahead of you.`);
  }

  lines.push(
    "",
    `📊 Rank: ${formatRankMovement(input.previousRank, input.nextRank)}`,
    `Prize if game ended now: ${formatMoney(input.prizeIfEndedNow)}`
  );

  return lines.join("\n");
}

export function getVirtualStartBalance(entryFee: number): number {
  return roundMoney(entryFee * FANTASY_ENTRY_MULTIPLIER);
}

export async function listFantasyArenaLobby(): Promise<FantasyArenaLobbySnapshot> {
  const [activeGames, openGames] = await Promise.all([
    listActiveFantasyGames(new Date().toISOString()),
    listOpenFantasyGames(),
  ]);
  const cards: FantasyArenaLobbyCard[] = [];

  for (const game of [...activeGames, ...openGames]) {
    if (game.status === "completed" || game.status === "cancelled") {
      continue;
    }

    const leaderboard = await getFantasyLeaderboard(game.id);
    const state = getArenaLobbyState(game, leaderboard.length);
    const leader = leaderboard[0] ?? null;

    cards.push({
      game,
      memberCount: leaderboard.length,
      state,
      topLeaderName: leader ? anonymizePlayer(leader.telegram_id) : null,
      topLeaderReturnPct: leader
        ? getVirtualReturnPct(game, leader.virtual_balance)
        : null,
    });
  }

  return {
    live: cards.filter((card) => card.state === "LIVE").slice(0, 3),
    filling: cards.filter((card) => card.state === "FILLING").slice(0, 3),
    open: cards.filter((card) => card.state === "OPEN").slice(0, 3),
  };
}

export async function getFantasyLeagueStatusView(
  telegramId: number,
  code: string
): Promise<FantasyLeagueStatusView> {
  const { game, leaderboard, memberCount } = await getFantasyLeagueDetailsByCode(code);
  const me = leaderboard.find((entry) => entry.telegram_id === telegramId) ?? null;
  const trades = await listFantasyTradesForGame(game.id);

  return {
    game,
    leaderboard,
    memberCount,
    me,
    prizeIfEndedNow: getProjectedPrizeForUser(leaderboard, game.prize_pool, telegramId),
    roundsLeft: getApproxRoundsLeft(game.end_at),
    roundsPlayed: countRoundsPlayed(trades),
    lastTrade: await getLatestFantasyTradeForMember(game.id, telegramId),
  };
}

export async function getFantasyTradeStakeSelectionView(input: {
  telegramId: number;
  callbackData: string;
}): Promise<FantasyTradeStakeSelectionView> {
  const parts = input.callbackData.split(":");

  if (parts.length < 5 || parts[0] !== "flt" || parts[1] !== "b" || parts[3] !== "r") {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const direction = parts[2];
  const ref = parts.slice(4).join(":");

  if (!ref || (direction !== "UP" && direction !== "DOWN")) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const payload = await loadFantasyTradeReference(ref);

  if (!payload) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  if (Date.parse(payload.closingDate) <= Date.now()) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const game = await getFantasyGameById(payload.gameId);

  if (!game || game.status !== "active") {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  if (Date.parse(game.end_at) <= Date.now()) {
    throw new Error("This league has already ended.");
  }

  const member = await getFantasyGameMember(game.id, input.telegramId);

  if (!member) {
    throw new Error("You are not a member of this arena.");
  }

  return {
    game,
    direction,
    directionPrice:
      direction === "UP" ? payload.upPrice : payload.downPrice,
    roundNumber: getGameRoundNumber(game, payload.openingDate),
    closesAt: payload.closingDate,
    currentPrice: payload.currentPrice,
    referencePrice: payload.referencePrice,
    upPrice: payload.upPrice,
    downPrice: payload.downPrice,
  };
}

export async function buildFantasyTradeStakeSelection(input: {
  telegramId: number;
  callbackData: string;
  chatId?: number;
  messageId?: number;
}): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const selection = await getFantasyTradeStakeSelectionView({
    telegramId: input.telegramId,
    callbackData: input.callbackData,
  });
  const parts = input.callbackData.split(":");
  const direction = parts[2] as FantasyTradeDirection;
  const ref = parts.slice(4).join(":");
  const promptState = getPromptStateFromMessage(input.chatId, input.messageId);

  if (promptState) {
    promptState.state.stage = "stake";
    promptState.state.currentPrice = selection.currentPrice;
    promptState.state.referencePrice = selection.referencePrice;
    promptState.state.selectedDirection = direction;
    promptState.state.selectedStake = null;
    promptState.state.telegramId = input.telegramId;

    return {
      text: buildLiveRoundPromptText(promptState.state),
      keyboard: buildRoundPromptKeyboard(promptState.state),
    };
  }

  const lines = [
    buildLiveRoundQuestion(selection.referencePrice),
    "",
    `Current price: ${formatLiveRoundPromptBtcPrice(selection.currentPrice)}`,
    `Target price: ${formatLiveRoundPromptBtcPrice(selection.referencePrice)}`,
    `↑ UP  ${formatProbabilityPrice(selection.upPrice)}   •   ↓ DOWN  ${formatProbabilityPrice(
      selection.downPrice
    )}`,
    "",
    `⏱ ${formatRoundCountdown(selection.closesAt)} remaining`,
  ];

  return {
    text: lines.join("\n"),
    keyboard: buildFantasyTradeStakeKeyboard({
      direction,
      ref,
    }),
  };
}

export function clearFantasyTradePromptState(
  chatId?: number,
  messageId?: number
): void {
  const promptState = getPromptStateFromMessage(chatId, messageId);

  if (!promptState) {
    return;
  }

  clearPromptState(promptState.key);
}

export async function createFantasyLeagueGame(
  creatorTelegramId: number,
  entryFee: number,
  durationHours = FANTASY_DEFAULT_DURATION_HOURS
): Promise<FantasyGame> {
  const normalizedEntryFee = roundMoney(entryFee);
  const normalizedDurationHours = normalizeFantasyDurationHours(durationHours);

  if (
    !Number.isInteger(normalizedEntryFee) ||
    normalizedEntryFee < FANTASY_MIN_ENTRY_FEE ||
    normalizedEntryFee > FANTASY_MAX_ENTRY_FEE
  ) {
    throw new Error(
      `Entry fee must be a whole number between $${FANTASY_MIN_ENTRY_FEE} and $${FANTASY_MAX_ENTRY_FEE}.`
    );
  }

  const startAt = await getNextRoundStart(FANTASY_ASSET);

  if (!startAt) {
    throw new Error("No upcoming BTC 15M round found right now.");
  }

  const endAt = new Date(
    Date.parse(startAt) + getFantasyDurationMs(normalizedDurationHours)
  ).toISOString();
  const virtualStartBalance = getVirtualStartBalance(normalizedEntryFee);
  const code = await generateUniqueFantasyGameCode();
  await upsertUserProfile(creatorTelegramId);

  return createFantasyGameWithEntry({
    code,
    creatorTelegramId,
    entryFee: normalizedEntryFee,
    virtualStartBalance,
    startAt,
    endAt,
    commissionRate: FANTASY_COMMISSION_RATE,
  });
}

export async function joinFantasyLeagueGame(
  telegramId: number,
  code: string
): Promise<FantasyGame> {
  await upsertUserProfile(telegramId);

  return joinFantasyGameWithEntry({
    code: code.trim().toUpperCase(),
    telegramId,
    commissionRate: FANTASY_COMMISSION_RATE,
  });
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
  const leader = leaderboard[0] ?? null;
  const projectedPrizePool = getPrizePoolBreakdown(
    game.entry_fee,
    leaderboard.length + 1
  ).netPrizePool;

  return {
    game,
    memberCount: leaderboard.length,
    projectedPrizePool,
    projectedFirstPrize: getFirstPrizeProjection(projectedPrizePool, leaderboard.length + 1),
    currentLeaderName: leader ? anonymizePlayer(leader.telegram_id, telegramId) : null,
    currentLeaderReturnPct: leader
      ? getVirtualReturnPct(game, leader.virtual_balance)
      : null,
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
      `Duration: ${formatDurationHours(getGameDurationHours(refreshed))}`,
      "You will receive a fantasy BTC round prompt for each Bayse BTC 15M round until the arena ends.",
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
  if (Date.parse(round.closingDate) <= Date.now()) {
    return;
  }

  const activeGames = await listActiveFantasyGames(new Date().toISOString());

  for (const game of activeGames) {
    if (game.last_round_event_id === pricing.eventId) {
      continue;
    }

    const members = await listFantasyGameMembers(game.id);
    const leaderboard = await getFantasyLeaderboard(game.id);
    const currentPrice = await getRoundCurrentPrice(pricing);
    const roundRef = await buildTradeReference({
      gameId: game.id,
      eventId: pricing.eventId,
      marketId: pricing.marketId,
      openingDate: round.openingDate,
      closingDate: round.closingDate,
      currentPrice,
      referencePrice: pricing.eventThreshold,
      upPrice: pricing.upPrice,
      downPrice: pricing.downPrice,
      upOutcomeId: pricing.upOutcomeId,
      downOutcomeId: pricing.downOutcomeId,
    });

    const deliveryResults = await Promise.all(
      members.map(async (member) => {
        const rank =
          leaderboard.find((entry) => entry.telegram_id === member.telegram_id)?.place ??
          null;

        if (rank === null) {
          return false;
        }

        const prompt = buildRoundBroadcastPayload({
          game,
          round,
          pricing,
          currentPrice,
          rank,
          memberCount: leaderboard.length,
          virtualBalance: member.virtual_balance,
          ref: roundRef,
        });
        const reminderActive = await consumeFantasyNextRoundReminder(
          game.id,
          member.telegram_id
        );
        const sent = await safeSendMessageAndReturn(
          member.telegram_id,
          reminderActive
            ? ["🔔 Don't miss this round.", "", prompt.text].join("\n")
            : prompt.text,
          prompt.keyboard
        );

        if (sent) {
          schedulePromptCountdown({
            ...prompt.state,
            chatId: member.telegram_id,
            messageId: sent.message_id,
            telegramId: member.telegram_id,
          });
          return true;
        }

        return false;
      })
    );

    if (!deliveryResults.some(Boolean)) {
      console.warn(
        `[fantasy] No round prompts delivered for arena ${game.code} on ${pricing.eventId}.`
      );
      continue;
    }

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

  const parts = callbackData.split(":");

  if (
    parts.length < 6 ||
    parts[0] !== "flt" ||
    parts[1] !== "d" ||
    parts[4] !== "r"
  ) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const stake = roundMoney(Number.parseFloat(parts[2] ?? ""));
  const direction = parts[3];
  const ref = parts.slice(5).join(":");

  if (
    !Number.isFinite(stake) ||
    stake <= 0 ||
    !ref ||
    (direction !== "UP" && direction !== "DOWN")
  ) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const payload = await loadFantasyTradeReference(ref);

  if (!payload) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  if (Date.parse(payload.closingDate) <= Date.now()) {
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

  const outcomeId = getOutcomeIdForDirection(direction, payload, pricing);

  if (!outcomeId) {
    throw new Error("Pricing is unavailable for this fantasy round.");
  }

  if (Date.parse(payload.closingDate) <= Date.now()) {
    throw new Error("This round has ended. Wait for the next BTC signal to trade.");
  }

  const quote = await getTradeQuote({
    eventId: payload.eventId,
    marketId: payload.marketId,
    outcomeId,
    amount: stake,
    currency: "USD",
  });

  if (!quote) {
    throw new Error("This fantasy round is no longer available.");
  }

  if (quote.tradeGoesOverMaxLiability) {
    throw new Error("That stake is too large for this fantasy round right now.");
  }

  const entryPrice = quote.price;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("Pricing is unavailable for this fantasy round.");
  }

  const shares = quote.quantity;

  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error("Pricing is unavailable for this fantasy round.");
  }

  try {
    await placeFantasyTradeWithDebit({
      gameId: game.id,
      memberId: member.id,
      telegramId: input.telegramId,
      eventId: payload.eventId,
      marketId: payload.marketId,
      direction,
      stake,
      entryPrice,
      shares,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (message.toLowerCase().includes("insufficient virtual balance")) {
      throw new Error(
        `Insufficient virtual balance. Available: ${formatMoney(member.virtual_balance)}`
      );
    }

    throw error;
  }

  const refreshedMember = await getFantasyGameMember(game.id, input.telegramId);

  return {
    game,
    stake,
    direction,
    roundNumber: getGameRoundNumber(game, payload.openingDate),
    entryPrice,
    shares,
    remainingBalance: refreshedMember?.virtual_balance ?? 0,
    stackIfWin: roundMoney((refreshedMember?.virtual_balance ?? 0) + shares),
    stackIfLoss: refreshedMember?.virtual_balance ?? 0,
    closesAt: payload.closingDate,
  };
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

      const previousLeaderboard = await getFantasyLeaderboard(game.id);
      const previousRanks = new Map(
        previousLeaderboard.map((entry) => [entry.telegram_id, entry.place] as const)
      );
      const previousBalances = new Map(
        previousLeaderboard.map(
          (entry) => [entry.telegram_id, entry.virtual_balance] as const
        )
      );

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
      const refreshedLeaderboard = await getFantasyLeaderboard(game.id);
      const roundNumber = getGameRoundNumber(game, trade.created_at);
      const refreshedRanks = new Map(
        refreshedLeaderboard.map((entry) => [entry.telegram_id, entry.place] as const)
      );
      const tradesByMemberId = new Map(
        allTradesForRound.map((entry) => [entry.member_id, entry] as const)
      );

      await Promise.all(
        members.map(async (member) => {
          const tradeForMember = tradesByMemberId.get(member.id) ?? null;
          const previousBalance =
            tradeForMember && tradeForMember.outcome === "LOSS"
              ? roundMoney(
                  (previousBalances.get(member.telegram_id) ?? member.virtual_balance) +
                    tradeForMember.stake
                )
              : previousBalances.get(member.telegram_id) ?? member.virtual_balance;
          const nextLeader =
            refreshedLeaderboard[0] &&
            refreshedLeaderboard[0].telegram_id !== member.telegram_id
              ? anonymizePlayer(refreshedLeaderboard[0].telegram_id, member.telegram_id)
              : null;
          const keyboard = new InlineKeyboard().text(
            "View leaderboard",
            `arena:board:${game.code}`
          );

          if (!tradeForMember) {
            keyboard.text("Don't miss the next round", `arena:remind:${game.code}`);
          }

          await safeSendMessage(
            member.telegram_id,
            renderRoundSettlementMessage({
              game,
              roundNumber,
              resolvedDirection,
              trade: tradeForMember,
              previousRank: previousRanks.get(member.telegram_id) ?? null,
              nextRank:
                refreshedRanks.get(member.telegram_id) ?? refreshedLeaderboard.length,
              nextLeaderName: nextLeader,
              previousBalance,
              virtualBalance: member.virtual_balance,
              prizeIfEndedNow: getProjectedPrizeForUser(
                refreshedLeaderboard,
                game.prize_pool,
                member.telegram_id
              ),
            }),
            keyboard
          );

          const missedKey = fantasyMissedStreakKey(game.id, member.telegram_id);

          if (tradeForMember) {
            await redis.del(missedKey);
            return;
          }

          const streak = await redis.incr(missedKey);

          if (streak === 1) {
            await redis.expire(
              missedKey,
              Math.max(
                60,
                Math.ceil(
                  (Date.parse(game.end_at) - Date.parse(game.start_at)) / 1000
                )
              )
            );
          }

          if (streak === FANTASY_MISSED_STREAK_ALERT) {
            await safeSendMessage(
              member.telegram_id,
              [
                "You've sat out 3 rounds in a row.",
                "",
                nextLeader
                  ? `You're still in it, but ${nextLeader} is pulling away.`
                  : "You're still in it.",
                "",
                "Next round opens soon. I'll ping you.",
              ].join("\n")
            );
          }
        })
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
    const awards = getPrizeAwardPreview(leaderboard, settledGame.prize_pool);
    let payoutFailed = false;

    for (const award of awards) {
      if (paidTelegramIds.has(award.telegramId)) {
        continue;
      }

      const amount = roundMoney(award.amount);

      if (amount <= 0) {
        continue;
      }

      const member = await getFantasyGameMember(game.id, award.telegramId);

      if (!member) {
        continue;
      }

      try {
        const awarded = await awardFantasyPrize({
          gameId: game.id,
          memberId: member.id,
          telegramId: award.telegramId,
          place: award.place,
          amount,
        });

        if (!awarded) {
          continue;
        }

        await creditBalance(award.telegramId, amount, {
          reason: "fantasy_prize",
          referenceType: "fantasy_game",
          referenceId: game.code,
          metadata: {
            place: award.place,
            amount,
          },
        });
      } catch (error) {
        payoutFailed = true;
        await revokeFantasyPrize({
          gameId: game.id,
          telegramId: award.telegramId,
        }).catch((rollbackError) => {
          console.error(
            `[fantasy] Failed to roll back prize claim for ${game.code}/${award.telegramId}:`,
            rollbackError
          );
        });
        console.error(
          `[fantasy] Failed to award prize for ${game.code}/${award.telegramId}:`,
          error
        );
      }
    }

    if (payoutFailed) {
      continue;
    }

    await syncFantasyPrizeAwards(game.id);

    const refreshedLeaderboard = await getFantasyLeaderboard(game.id);
    const roundsPlayed = countRoundsPlayed(await listFantasyTradesForGame(game.id));
    const botUsername = await getBotUsername();

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

    await Promise.all(
      members.map(async (member) => {
        const me =
          refreshedLeaderboard.find((entry) => entry.telegram_id === member.telegram_id) ??
          null;
        const leader = refreshedLeaderboard[0] ?? null;
        const shareUrl =
          me && leader
            ? buildShareResultUrl({
                botUsername,
                entryFee: completedGame.entry_fee,
                finishPlace: me.place,
                fieldSize: refreshedLeaderboard.length,
                returnPct: getVirtualReturnPct(completedGame, me.virtual_balance),
                leaderReturnPct: getVirtualReturnPct(
                  completedGame,
                  leader.virtual_balance
                ),
              })
            : null;
        const keyboard = new InlineKeyboard().text("▶ Play again", "arena:create");

        if (shareUrl) {
          keyboard.url("📤 Share result", shareUrl);
        }

        await safeSendMessage(
          member.telegram_id,
          buildFinalArenaMessage({
            game: completedGame,
            leaderboard: refreshedLeaderboard,
            viewerTelegramId: member.telegram_id,
            roundsPlayed,
          }),
          keyboard
        );
      })
    );
  }
}

export async function getFantasyLeagueBoardText(
  code: string,
  viewerTelegramId: number
): Promise<string> {
  const { game, leaderboard } = await getFantasyLeagueDetailsByCode(code);
  return renderLeaderboardText({ game, leaderboard, viewerTelegramId });
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
    `Duration: ${formatDurationHours(getGameDurationHours(game))}`,
    `Starts: ${formatMediumDateTime(game.start_at)}`,
    `Ends: ${formatMediumDateTime(game.end_at)}`,
    "",
    "Private beta wallets are virtual only. Joining is final for this test round.",
  ].join("\n");
}
