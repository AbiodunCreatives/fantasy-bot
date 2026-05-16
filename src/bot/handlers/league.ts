import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { PublicKey } from "@solana/web3.js";

import { getCurrentRoundSnapshot } from "../../bayse-market.ts";
import { getBtcChartMenuUrl } from "../../btc-chart-menu.ts";
import { config } from "../../config.ts";
import { getBalance } from "../../db/balances.ts";
import {
  buildFantasyTradeStakeSelection,
  clearPendingFantasyCustomFundAmount,
  clearFantasyTradePromptState,
  clearPendingFantasyLeagueJoin,
  createFantasyLeagueGame,
  getFantasyLeagueStatusView,
  getFantasyLeagueBoardText,
  hasPendingFantasyCustomFundAmount,
  hasPendingCustomArenaFee,
  savePendingCustomArenaFee,
  clearPendingCustomArenaFee,
  getFantasyLeagueDetailsByCode,
  getFantasyLeagueJoinPreview,
  joinFantasyLeagueGame,
  listFantasyArenaLobby,
  listFantasyLeagueSnapshots,
  loadPendingFantasyLeagueJoin,
  placeFantasyTradeFromCallbackData,
  prepareFantasyTradePromptForArena,
  registerFantasyTradePromptDelivery,
  saveFantasyNextRoundReminder,
  savePendingFantasyCustomFundAmount,
  savePendingFantasyLeagueJoin,
  saveOfframpSession,
  loadOfframpSession,
  clearOfframpSession,
  FANTASY_MIN_ENTRY_FEE,
  type FantasyTradePlacementResult,
  type OfframpSessionState,
} from "../../fantasy-league.ts";
import {
  ARENA_DURATION_HOURS_OPTIONS,
  ARENA_ENTRY_FEE_OPTIONS,
  anonymizePlayer,
  buildShareInviteUrl,
  formatBtcPrice,
  formatDurationHours,
  formatCompactDuration,
  formatProbabilityPrice,
  formatSignedPercent,
  formatWholeMoney,
  formatRoundCountdown,
  getGameDurationHours,
  getGameRoundNumber,
  getApproxRoundsUntil,
  getRoundsForDurationHours,
} from "../../fantasy-ui.ts";
import {
  getFantasyWalletSummary,
  processFantasyWalletWithdrawals,
  requestFantasyWalletWithdrawal,
  syncFantasyWalletDeposits,
  transferTreasuryUsdc,
  createCrossChainDeposit,
} from "../../solana-wallet.ts";
import { createFantasyPajCashOnramp, getBanks, confirmBankAccount, createFantasyPajCashOfframp, PAJCASH_OFFRAMP_MIN_USDC } from "../../pajcash.ts";
import { isDevUser } from "../../utils/devOverrides.ts";

const START_HOW_IT_WORKS = "start:how";
const START_LOBBY = "start:lobby";
const START_WALLET = "start:wallet";
const LOBBY_REFRESH = "lobby:refresh";
const LOBBY_LIVE = "lobby:live";
const ARENA_CREATE = "arena:create";
const ARENA_DURATION_PREFIX = "arena:duration:";
const ARENA_BACK_TO_LOBBY = "arena:lobby";
const ARENA_LIVE_PREFIX = "arena:live:";
const ARENA_TRADE_PREFIX = "arena:trade:";
const ARENA_REFRESH_PREFIX = "arena:refresh:";
const ARENA_CATCH_UP_PREFIX = "arena:catch:";
const ARENA_REMIND_PREFIX = "arena:remind:";
const ARENA_JOIN_CONFIRM = "fantasy:join:confirm";
const ARENA_JOIN_DECLINE = "fantasy:join:decline";
const FUNDS_ADD = "funds:add";
const FUNDS_CUSTOM = "funds:custom";
const FUNDS_BACK_TO_LOBBY = "funds:lobby";
const WALLET_OPEN = "wallet:open";
const WALLET_REFRESH = "wallet:refresh";
const WALLET_NAIRA_HELP = "wallet:naira";
const WALLET_NAIRA_AMOUNT_PREFIX = "wallet:naira:amount:";
const WALLET_NAIRA_CUSTOM = "wallet:naira:custom";
const WALLET_NAIRA_BACK = "wallet:naira:back";
const WALLET_WITHDRAW_HELP = "wallet:withdraw";
const WALLET_BACK = "wallet:back";
const WALLET_CROSS_CHAIN = "wallet:cross";
const ARENA_CREATE_CUSTOM = "arena:create:custom";
const WALLET_NAIRA_MIN_AMOUNT = 1_000;
const WALLET_NAIRA_MAX_AMOUNT = 20_000;
const WALLET_NAIRA_PRESET_AMOUNTS = [1_000, 2_000, 5_000, 10_000] as const;

const OFFRAMP_CANCEL = "offramp:cancel";
const OFFRAMP_CONFIRM = "offramp:confirm";

type FantasyLeagueStatusViewData = Awaited<
  ReturnType<typeof getFantasyLeagueStatusView>
>;
type ArenaCurrentRoundSnapshot = Awaited<ReturnType<typeof getCurrentRoundSnapshot>>;

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

function formatUsdc(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  const minimumFractionDigits = Number.isInteger(rounded) ? 0 : 2;

  return `${rounded.toLocaleString("en-US", {
    minimumFractionDigits,
    maximumFractionDigits: 6,
  })} USDC`;
}

function formatNaira(value: number): string {
  return `NGN ${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(roundMoney(value)) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNairaCompact(value: number): string {
  return `₦${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(roundMoney(value)) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function abbreviateAddress(value: string): string {
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isValidSolanaAddress(value: string): boolean {
  try {
    void new PublicKey(value.trim());
    return true;
  } catch {
    return false;
  }
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
    "Check the code and try again, or create your own with /league create <entry_fee> <hours>.",
  ].join("\n");
}

function buildArenaStartedText(): string {
  return [
    "This arena has already started.",
    "",
    "You can create your own with /league create <entry_fee> <hours>.",
  ].join("\n");
}

function buildArenaInsufficientBalanceText(
  entryFee: number,
  balance: number
): string {
  return [
    "Insufficient USDC balance.",
    "",
    `You need ${formatMoney(entryFee)} available for this arena entry.`,
    `Your wallet balance: ${formatUsdc(balance)}`,
    "",
    "Deposit USDC on Solana into your in-bot wallet, then try again.",
  ].join("\n");
}

function buildStartWelcomeText(): string {
  return [
    "🏆 *HeadlineOdds Arena*",
    "",
    "BTC fantasy trading on Solana\\.",
    "Predict price moves, grow your stack, win real USDC\\.",
  ].join("\n");
}

function buildStartWelcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("▶ How it works", START_HOW_IT_WORKS)
    .text("🏟 Browse Arenas", START_LOBBY);
}

function buildHowItWorksText(): string {
  return [
    "1. Open /wallet to get your personal Solana USDC deposit address",
    "2. Deposit USDC on Solana and wait for the bot to credit your balance",
    "3. Arena entry fees ($1-$10) come from that in-bot USDC balance",
    "4. Your arena stack is still entry fee x 100 for trading",
    "5. Winnings land back in your in-bot balance and can be withdrawn to any Solana wallet",
  ].join("\n");
}

function buildHowItWorksKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏟 Got it - let me in", START_LOBBY);
}

function buildBtcChartKeyboard(): InlineKeyboard {
  const url = getBtcChartMenuUrl();
  const keyboard = new InlineKeyboard();

  if (url) {
    keyboard.url("Open chart", url).row();
  }

  keyboard.text("🏟 Browse arenas", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildStartOnboardingText(input: {
  firstName: string;
  balance: number;
}): string {
  const name = input.firstName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  const balance = input.balance.toFixed(2).replace(/[.]/g, '\\$&');
  return [
    `👋 *Welcome, ${name}\\!*`,
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "🏆 *HeadlineOdds Arena*",
    "_BTC fantasy trading · Real USDC prizes_",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    "💡 *How it works*",
    "• Pay a small entry fee \\($1–$10\\)",
    "• Get a virtual stack 100× your entry",
    "• Trade BTC UP/DOWN across 15\\-min rounds",
    "• Best bankroll at the end wins the prize pool",
    "",
    `💳 *Your balance:* \`$${balance} USDC\``,
    "",
    "Deposit USDC on Solana to fund your wallet\\.",
  ].join("\n");
}

function buildStartOnboardingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Create Arena", ARENA_CREATE)
    .text("💳 Wallet", START_WALLET)
    .row()
    .text("🏟 Browse Arenas", START_LOBBY)
    .text("💵 Fund NGN", WALLET_NAIRA_HELP);
}

function buildCreateArenaPickerText(balance: number): string {
  return [
    "⚡ New Arena",
    "",
    "Pick an entry fee:",
    "",
    `Available balance: ${formatUsdc(balance)}`,
  ].join("\n");
}

function buildCreateArenaPickerKeyboard(telegramId?: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const fee of ARENA_ENTRY_FEE_OPTIONS) {
    keyboard.text(`$${fee}`, `arena:create:${fee}`);
  }

  if (telegramId && isDevUser(telegramId)) {
    keyboard.row().text("Custom", ARENA_CREATE_CUSTOM);
  }

  keyboard.row().text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildCreateArenaDurationText(input: {
  balance: number;
  entryFee: number;
}): string {
  return [
    "⚡ New Arena",
    "",
    `Entry fee: ${formatMoney(input.entryFee, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`,
    "Pick how long the arena should run:",
    "4 rounds play every hour.",
    "",
    `Available balance: ${formatUsdc(input.balance)}`,
  ].join("\n");
}

function buildCreateArenaDurationKeyboard(entryFee: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  ARENA_DURATION_HOURS_OPTIONS.forEach((hours, index) => {
    keyboard.text(
      `${formatDurationHours(hours)} (${getRoundsForDurationHours(hours)}r)`,
      `${ARENA_DURATION_PREFIX}${entryFee}:${hours}`
    );

    if (index % 2 === 1 && index < ARENA_DURATION_HOURS_OPTIONS.length - 1) {
      keyboard.row();
    }
  });

  keyboard
    .row()
    .text("⚡ Pick a different fee", ARENA_CREATE)
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);

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
      .text("📈 Status", `arena:status:${code}`)
      .text("🎯 Leaderboard", `arena:board:${code}`)
      .row();
  }

  keyboard.text("⚡ Create New Arena", ARENA_CREATE).text("🏟 Browse Lobby", START_LOBBY);
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
  joinedCodes: string[];
  liveOnly?: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const joinedCodes = new Set(input.joinedCodes);

  for (const card of input.live) {
    keyboard
      .text(
        `${joinedCodes.has(card.code) ? "🔴 Live" : "👁 Watch"} ${card.code}`,
        joinedCodes.has(card.code)
          ? `${ARENA_LIVE_PREFIX}${card.code}`
          : `arena:watch:${card.code}`
      )
      .row();
  }

  if (!input.liveOnly) {
    for (const card of [...input.filling, ...input.open]) {
      if (joinedCodes.has(card.code)) {
        keyboard.text(`📈 Open ${card.code}`, `arena:status:${card.code}`).row();
        continue;
      }

      keyboard
        .text(
          `🎯 Join ${card.code} - ${formatMoney(card.entryFee, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`,
          `arena:join:${card.code}`
        )
        .row();
    }
  }

  keyboard.text("⚡ Create New Arena", ARENA_CREATE);

  if (input.liveOnly) {
    keyboard.text("🏟 Browse all", START_LOBBY);
  } else {
    keyboard.text("🔄 Refresh", LOBBY_REFRESH);
  }

  return keyboard;
}

function buildFantasyJoinPreviewText(input: {
  code: string;
  entryFee: number;
  durationHours: number;
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
  const durationText = `Duration: ${formatDurationHours(
    input.durationHours
  )}  •  ${getRoundsForDurationHours(input.durationHours)} rounds`;

  return [
    `⚡ Arena ${input.code}`,
    "",
    `Entry: ${formatMoney(input.entryFee)}  •  ${input.playerCount} players`,
    `Net prize pool: ${formatMoney(input.prizePool)}`,
    `Your cut if you win 1st: ${formatMoney(input.projectedFirstPrize)}`,
    "",
    startsInText,
    durationText,
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
  durationHours: number;
}): string {
  return [
    "✅ Arena created",
    "",
    `Code: ${input.code}`,
    `Prize pool: ${formatMoney(input.prizePool)} (grows as others join)`,
    `Your virtual stack: ${formatWholeMoney(input.virtualStack)}`,
    `Duration: ${formatDurationHours(input.durationHours)}`,
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
  durationHours: number;
}): string {
  return [
    "You're in. 🟢",
    "",
    `Arena: ${input.code}`,
    `Your virtual stack: ${formatWholeMoney(input.virtualBalance)}`,
    `Prize pool: ${formatMoney(input.prizePool)} (${input.playerCount} players)`,
    `Duration: ${formatDurationHours(input.durationHours)}`,
    "",
    input.roundsUntilStart <= 0
      ? "Starts in: next BTC round"
      : `Starts in: ~${input.roundsUntilStart * 15} min`,
    `Wallet balance: ${formatUsdc(input.playBalance)}`,
    "I'll ping you when round 1 opens.",
  ].join("\n");
}

function buildInsufficientBalanceWithOptionsText(balance: number): string {
  return [
    "You do not have enough USDC to join this arena.",
    "",
    `Wallet balance: ${formatUsdc(balance)}`,
  ].join("\n");
}

function buildInsufficientBalanceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💳 Open wallet", WALLET_OPEN)
    .text("🔴 Watch live arena", LOBBY_LIVE);
}

function buildCreateInsufficientKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💳 Open wallet", WALLET_OPEN)
    .text("⚡ Pick a lower fee", ARENA_CREATE);
}

function buildAddFundsText(): string {
  return [
    "💵 Add Funds",
    "",
    "Open /wallet to view your Solana USDC deposit address.",
    "You can also tap Fund NGN or use /wallet fund-ngn 10000 to top up from a Naira bank transfer via PajCash.",
    "Deposits credit your in-bot balance and withdrawals pay out to any Solana wallet.",
  ].join("\n");
}

function buildAddFundsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💳 Open wallet", WALLET_OPEN)
    .text("🏟 Browse arenas", FUNDS_BACK_TO_LOBBY);
}

function buildCustomFundsPromptText(): string {
  return buildAddFundsText();
}

function buildFundsAddedText(amount: number, balance: number): string {
  return [
    `Wallet balance: ${formatUsdc(balance)}`,
    "",
    "Your deposit has been credited.",
  ].join("\n");
}

function buildFundsAddedKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏟 Browse Arenas", START_LOBBY);
}

function buildWalletText(summary: Awaited<ReturnType<typeof getFantasyWalletSummary>>): string {
  const ledgerLines =
    summary.recentLedger.length === 0
      ? []
      : summary.recentLedger.slice(0, 4).map((entry) => {
          const sign = entry.direction === "credit" ? "+" : "-";
          const label =
            entry.entry_type === "deposit"
              ? "Deposit"
              : entry.entry_type === "arena_entry"
                ? "Arena entry"
                : entry.entry_type === "fantasy_prize"
                  ? "Prize"
                  : entry.entry_type === "withdrawal_request"
                    ? "Withdrawal"
                    : entry.entry_type.replace(/_/g, " ");

          return `${sign}${formatUsdc(entry.amount)}  ${label}`;
        });
  const withdrawalLines =
    summary.recentWithdrawals.length === 0
      ? ["None"]
      : summary.recentWithdrawals.slice(0, 3).map((entry) => {
          const destination = abbreviateAddress(entry.destination_address);
          return `${entry.status.toUpperCase()}  ${formatUsdc(entry.amount)}  ->  ${destination}`;
        });
  const onrampLines =
    summary.recentOnramps.length === 0
      ? ["None"]
      : summary.recentOnramps.slice(0, 3).map((entry) => {
          const amount =
            entry.actual_usdc_amount > 0
              ? entry.actual_usdc_amount
              : entry.expected_usdc_amount;

          return `${formatNaira(entry.fiat_amount)}  ->  ${formatUsdc(amount)}  ${entry.status.toUpperCase()}`;
        });

  const recentActivityHeader = ledgerLines.length > 0 ? "Recent activity:" : "";

  return [
    "💰 Solana USDC Wallet",
    "",
    `Available balance: ${formatUsdc(summary.balance)}`,
    "Network: Solana",
    "",
    "Deposit address:",
    summary.wallet.owner_address,
    "",
    "For Naira top-ups via Paj, tap Fund NGN",
    "",
    recentActivityHeader,
    ...ledgerLines,
    recentActivityHeader ? "" : "",
    "Recent withdrawals:",
    ...withdrawalLines,
    "",
    "Recent Naira top-ups:",
    ...onrampLines,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildWalletKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Refresh deposits", WALLET_REFRESH)
    .text("💵 Fund NGN", WALLET_NAIRA_HELP)
    .row()
    .text("🌐 Deposit from other chain", WALLET_CROSS_CHAIN)
    .row()
    .text("🎮 Withdraw help", WALLET_WITHDRAW_HELP)
    .row()
    .text("🏟 Browse arenas", WALLET_BACK);
}

function buildWalletCrossChainHelpText(): string {
  return [
    "🌐 Deposit from Another Chain",
    "",
    "Send from Bitcoin, Tron, Ethereum, or 70+ chains — arrives as USDC in your wallet.",
    "",
    "/wallet deposit-cross <chainId> <tokenAddress> <amount>",
    "",
    "Examples:",
    "• 10 USDT from Tron:",
    "  /wallet deposit-cross 728126428 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t 10",
    "• 5 USDC from Ethereum:",
    "  /wallet deposit-cross 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 5",
  ].join("\n");
}

function buildWalletCrossChainResultText(input: {
  depositAddress: string;
  depositRequestId: string;
  originSymbol: string;
  expectedUsdcOut: number;
  expiresInSeconds: number;
}): string {
  const expiryMinutes = Math.round(input.expiresInSeconds / 60);
  return [
    "🌐 Cross-Chain Deposit Address",
    "",
    `Send your ${input.originSymbol} to:`,
    input.depositAddress,
    "",
    `Expected credit: ~${formatUsdc(input.expectedUsdcOut)}`,
    `Expires in: ${expiryMinutes} minutes`,
    "",
    "Once your transaction confirms, Dextopus converts it and USDC arrives in your in-bot wallet automatically.",
    "Use /wallet to check your balance.",
  ].join("\n");
}

function buildWalletNairaHelpText(): string {
  return [
    "💵 Fund NGN",
    "",
    "Choose a PajCash top-up amount below.",
    `Minimum: ${formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT)}`,
    `Maximum: ${formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT)}`,
    "",
    "You can also type /wallet fund-ngn <amount_ngn>.",
    "Example: /wallet fund-ngn 10000",
    "",
    "A PajCash bank transfer order will be created for you.",
    "Your in-bot balance updates only after native USDC lands in your Solana wallet and the bot sees the deposit.",
  ].join("\n");
}

function buildWalletNairaPickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[0]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[0]}`
    )
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[1]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[1]}`
    )
    .row()
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[2]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[2]}`
    )
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[3]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[3]}`
    )
    .row()
    .text("Custom Amount", WALLET_NAIRA_CUSTOM)
    .row()
    .text("Back to wallet", WALLET_NAIRA_BACK);
}

function buildWalletNairaCustomAmountText(): string {
  return [
    "💵 Custom Fund NGN",
    "",
    `Type any amount between ${formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT)} and ${formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT)}.`,
    "Examples:",
    "3500",
    "₦3,500",
    "",
    "Or tap one of the preset amounts below.",
  ].join("\n");
}

function buildWalletNairaCustomAmountKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[0]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[0]}`
    )
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[1]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[1]}`
    )
    .row()
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[2]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[2]}`
    )
    .text(
      formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[3]),
      `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[3]}`
    )
    .row()
    .text("Back to wallet", WALLET_NAIRA_BACK);
}

function buildWalletNairaAmountValidationText(message?: string): string {
  return [
    message ?? "Choose a valid Fund NGN amount.",
    "",
    `Minimum: ${formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT)}`,
    `Maximum: ${formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT)}`,
  ].join("\n");
}

function parseWalletNairaAmountInput(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/ngn/gi, "")
    .replace(/₦/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getWalletNairaAmountError(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return buildWalletNairaAmountValidationText("Enter a valid Naira amount.");
  }

  if (amount < WALLET_NAIRA_MIN_AMOUNT) {
    return buildWalletNairaAmountValidationText(
      `Minimum Fund NGN amount is ${formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT)}.`
    );
  }

  if (amount > WALLET_NAIRA_MAX_AMOUNT) {
    return buildWalletNairaAmountValidationText(
      `Maximum Fund NGN amount for now is ${formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT)}.`
    );
  }

  return null;
}

function buildWalletNairaOrderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💵 Fund NGN Again", WALLET_NAIRA_HELP)
    .text("💳 Open wallet", WALLET_OPEN)
    .row()
    .text("🏟 Browse arenas", WALLET_BACK);
}

function buildWalletCommandHelpText(): string {
  return [
    "💳 Wallet commands",
    "",
    "/wallet",
    "/wallet refresh",
    "/wallet fund-ngn 10000",
    "/wallet withdraw 5 SOLANA_ADDRESS",
  ].join("\n");
}

function buildWalletWithdrawHelpText(): string {
  return [
    "🎮 Withdraw USDC",
    "",
    `Use: /wallet withdraw <amount> <solana_address>`,
    `Minimum: ${formatUsdc(config.SOLANA_WITHDRAW_MIN_AMOUNT)}`,
    "",
    "Example:",
    "/wallet withdraw 5 FILL_IN_SOLANA_ADDRESS",
  ].join("\n");
}

function buildWalletNairaOrderText(input: {
  orderId: string;
  fiatAmount: number;
  expectedUsdcAmount: number;
  bankName: string;
  accountName: string;
  accountNumber: string;
}): string {
  return [
    "💰 Naira top-up ready.",
    "",
    `Order ID: ${input.orderId}`,
    `Send: ${formatNaira(input.fiatAmount)}`,
    `Expected credit: ${formatUsdc(input.expectedUsdcAmount)}`,
    "",
    "Transfer to:",
    `${input.accountName}`,
    `${input.accountNumber}`,
    `${input.bankName}`,
    "",
    "After PajCash completes the order and USDC lands in your Solana wallet, your in-bot balance will be credited.",
  ].join("\n");
}

async function createWalletNairaOrderText(
  telegramId: number,
  amount: number
): Promise<string> {
  const order = await createFantasyPajCashOnramp({
    telegramId,
    fiatAmount: amount,
  });

  return buildWalletNairaOrderText({
    orderId: order.order_id,
    fiatAmount: order.fiat_amount,
    expectedUsdcAmount: order.expected_usdc_amount,
    bankName: order.bank_name ?? "PAJ CASH",
    accountName: order.account_name ?? "PAJ CASH",
    accountNumber: order.account_number ?? "Unavailable",
  });
}

function buildWalletWithdrawalRequestedText(input: {
  amount: number;
  destinationAddress: string;
}): string {
  return [
    "✅ Withdrawal requested.",
    "",
    `Amount: ${formatUsdc(input.amount)}`,
    `Destination: ${input.destinationAddress}`,
    "",
    "The bot will broadcast the Solana transfer shortly.",
  ].join("\n");
}

function buildCatchUpText(input: {
  code: string;
  leaderName: string;
  gap: number;
  suggestedStake: number;
  requiredReturnMultiple: number;
}): string {
  return [
    `${input.leaderName} is ${formatWholeMoney(input.gap)} ahead.`,
    "",
    "To close the gap in one trade:",
    `- Stake ${formatWholeMoney(input.suggestedStake)} on the next round`,
    `- You'd need roughly a ${input.requiredReturnMultiple.toFixed(2)}x return`,
    "",
    "Risky, but doable across 2-3 good rounds.",
  ].join("\n");
}

function buildArenaStatusKeyboard(code: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Live market", `${ARENA_LIVE_PREFIX}${code}`)
    .text("🎯 Full leaderboard", `arena:board:${code}`)
    .row()
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
}

function buildArenaLiveKeyboard(input: {
  code: string;
  canCatchUp: boolean;
  marketUrl?: string;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (input.marketUrl) {
    keyboard.url("View market", input.marketUrl);
  }

  keyboard.text("📊 Leaderboard", `arena:board:${input.code}`);

  if (input.canCatchUp) {
    keyboard.row().text("⬆ How to catch #1", `${ARENA_CATCH_UP_PREFIX}${input.code}`);
  }

  keyboard
    .row()
    .text("🔄 Refresh live", `${ARENA_LIVE_PREFIX}${input.code}`)
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);

  return keyboard;
}

function buildArenaBoardKeyboard(input: {
  code: string;
  canCatchUp: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("⚡ Live market", `${ARENA_LIVE_PREFIX}${input.code}`).row();

  if (input.canCatchUp) {
    keyboard.text("⬆ How to catch #1", `${ARENA_CATCH_UP_PREFIX}${input.code}`);
  }

  keyboard
    .text("🔄 Refresh", `${ARENA_REFRESH_PREFIX}${input.code}`)
    .row()
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);

  return keyboard;
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
    "🏟 HEADLINE ODDS ARENA",
    "",
    "Commands:",
    "/start - Open the welcome screen and lobby",
    "/help - Show the command guide",
    "/chart - Open the BTC 15m chart link",
    "/wallet - View your Solana USDC wallet and deposit address",
    "/fundngn 10000 - Create a Naira top-up order via PajCash",
    "/withdraw 5 ADDRESS - Withdraw USDC to a Solana wallet",
    "/league - See your active arenas or browse the lobby",
    "/create 5 12 - Create a 12h BTC fantasy arena with $5 entry",
    "/join ABC123 - Review and join an arena by code",
    "/live ABC123 - View the current BTC round and countdown",
    "/board ABC123 - View the arena leaderboard",
    "/status ABC123 - View arena details",
    "",
    "Rules:",
    "- BTC only in v1",
    "- Arena durations: 3h, 9h, 12h, or 24h",
    "- Four Bayse BTC 15M rounds per hour",
    "- Entry fee buys virtual bankroll at 100x",
    "- One fantasy trade per round",
    "- Bot keeps 8% commission when the league closes",
    "- Top finishers split the prize pool (1v1 arenas: winner takes all)",
    "- Joining is final",
    "- Deposits and withdrawals use Solana USDC",
    "- Arena entries debit your in-bot USDC balance",
    "",
    "Arena balances stay virtual during play, but funding and payouts are real USDC.",
  ].join("\n");
}

function buildChartCommandText(): string {
  return [
    "📊 BTC 15m Chart",
    "",
    "Use the bot menu button to open the live BTC chart.",
    "If the menu button is not visible yet, use the button below.",
  ].join("\n");
}

function buildChartCommandKeyboard(): InlineKeyboard | undefined {
  const url = getBtcChartMenuUrl();

  if (!url) {
    return undefined;
  }

  return new InlineKeyboard().url("📊 Open BTC 15m Chart", url);
}

async function replyChartCommand(ctx: Context): Promise<void> {
  const keyboard = buildChartCommandKeyboard();

  if (keyboard) {
    await ctx.reply(buildChartCommandText(), {
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(
    "BTC chart menu is not available right now. Set WEBHOOK_URL so the bot can expose the chart page."
  );
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

async function replyFantasyCreateError(
  ctx: Context,
  error: unknown,
  entryFee: number
): Promise<void> {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (
    normalized.includes("insufficient play balance") ||
    normalized.includes("insufficient balance")
  ) {
    if (!ctx.from) {
      await editTradePromptMessage(ctx, "Something went wrong. Please try again.");
      return;
    }

    const balance = await getBalance(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildArenaInsufficientBalanceText(entryFee, balance),
      buildCreateInsufficientKeyboard()
    );
    return;
  }

  if (
    normalized.includes("entry fee must") ||
    normalized.includes("duration must")
  ) {
    await editTradePromptMessage(ctx, message);
    return;
  }

  if (
    normalized.includes("no upcoming btc 15m round") ||
    normalized.includes("no open btc 15m round")
  ) {
    await editTradePromptMessage(
      ctx,
      "No Bayse BTC round is available right now. Try again in a minute."
    );
    return;
  }

  if (normalized.includes("bayse api")) {
    await editTradePromptMessage(
      ctx,
      "I couldn't reach Bayse right now. Please try again in a moment."
    );
    return;
  }

  await editTradePromptMessage(ctx, "Something went wrong. Please try again.");
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

function formatTradeDirectionLabel(direction: "UP" | "DOWN"): string {
  return direction === "UP" ? "Buy YES" : "Buy NO";
}

function buildTradeLockedText(result: FantasyTradePlacementResult): string {
  return [
    `Round ${result.roundNumber} locked in - ${result.game.code}`,
    "",
    `Direction: ${formatTradeDirectionLabel(result.direction)}`,
    `Stake: ${formatMoney(result.stake)}`,
    `Buy price: ${Math.round(result.entryPrice * 100)}c`,
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
  telegramId: number,
  options?: { liveOnly?: boolean }
): Promise<void> {
  const [lobby, snapshots] = await Promise.all([
    listFantasyArenaLobby(),
    listFantasyLeagueSnapshots(telegramId),
  ]);
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
  const joinedCodes = snapshots.map((snapshot) => snapshot.game.code);

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
      joinedCodes,
      liveOnly: options?.liveOnly,
    })
  );
}

async function renderWalletView(
  ctx: Context,
  telegramId: number,
  options?: { refresh?: boolean }
): Promise<void> {
  const initial = await getFantasyWalletSummary(telegramId);

  if (options?.refresh) {
    await syncFantasyWalletDeposits(initial.wallet);
    await processFantasyWalletWithdrawals();
  }

  const summary = options?.refresh
    ? await getFantasyWalletSummary(telegramId)
    : initial;

  await editTradePromptMessage(
    ctx,
    buildWalletText(summary),
    buildWalletKeyboard()
  );
}

async function openLobbyOrFundingPrompt(
  ctx: Context,
  telegramId: number,
  options?: { liveOnly?: boolean }
): Promise<void> {
  const balance = await getBalance(telegramId);

  if (!options?.liveOnly && balance < FANTASY_MIN_ENTRY_FEE) {
    await editTradePromptMessage(
      ctx,
      buildInsufficientBalanceWithOptionsText(balance),
      buildInsufficientBalanceKeyboard()
    );
    return;
  }

  await renderArenaLobby(ctx, telegramId, options);
}

async function renderArenaStatusList(ctx: Context, telegramId: number): Promise<void> {
  const snapshots = await listFantasyLeagueSnapshots(telegramId);

  if (snapshots.length === 0) {
    await openLobbyOrFundingPrompt(ctx, telegramId);
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
      durationHours: getGameDurationHours(preview.game),
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

async function resolveArenaLiveCode(
  telegramId: number,
  code: string | undefined
): Promise<string | null> {
  if (code?.trim()) {
    return code.trim().toUpperCase();
  }

  const snapshots = await listFantasyLeagueSnapshots(telegramId);
  const active = snapshots.filter(
    (snapshot) =>
      snapshot.game.status === "active" && Date.parse(snapshot.game.end_at) > Date.now()
  );

  if (active.length === 1) {
    return active[0]?.game.code ?? null;
  }

  return null;
}

function buildArenaLiveText(input: {
  view: FantasyLeagueStatusViewData;
  snapshot: ArenaCurrentRoundSnapshot | null;
  spectating?: boolean;
}): string {
  const arenaMsRemaining = Date.parse(input.view.game.end_at) - Date.now();
  const joined = Boolean(input.view.me);
  const isActive =
    input.view.game.status === "active" && Date.parse(input.view.game.end_at) > Date.now();
  const lines: string[] = [];

  if (input.spectating && !joined) {
    lines.push("👀 Spectating", "");
  }

  lines.push(
    `⚡ Arena ${input.view.game.code}  •  ${isActive ? "LIVE" : input.view.game.status.toUpperCase()}`,
    ""
  );

  if (joined) {
    const returnPct =
      ((input.view.me!.virtual_balance - input.view.game.virtual_start_balance) /
        input.view.game.virtual_start_balance) *
      100;

    lines.push(
      `Your position: #${input.view.me!.place} of ${input.view.memberCount}`,
      `Stack: ${formatWholeMoney(input.view.me!.virtual_balance)}  (${formatSignedPercent(
        returnPct
      )})`,
      `Prize if game ends now: ${formatMoney(input.view.prizeIfEndedNow)}`
    );
  } else {
    lines.push(`Players: ${input.view.memberCount}`, "Mode: Spectator");
  }

  if (!isActive) {
    lines.push(
      "",
      input.view.game.status === "open"
        ? `Arena starts: ${formatDateTime(input.view.game.start_at)}`
        : `Arena ended: ${formatDateTime(input.view.game.end_at)}`,
      input.view.game.status === "open"
        ? `Starts in: ~${Math.max(1, getApproxRoundsUntil(input.view.game.start_at)) * 15} min`
        : "No live Bayse market for this arena right now."
    );

    return lines.join("\n");
  }

  lines.push(`Arena time left: ${formatCompactDuration(arenaMsRemaining)}`);

  if (!input.snapshot?.pricing) {
    lines.push("", "Current Bayse BTC market is unavailable right now. Try again in a minute.");
    return lines.join("\n");
  }

  const roundOpeningMs = Date.parse(input.snapshot.round.openingDate);
  const roundClosingMs = Date.parse(input.snapshot.round.closingDate);
  const roundNumber = getGameRoundNumber(input.view.game, input.snapshot.round.openingDate);
  const tradeWindowCloseMs =
    Number.isFinite(roundOpeningMs) && Number.isFinite(roundClosingMs)
      ? roundOpeningMs + (roundClosingMs - roundOpeningMs) * 0.2
      : null;

  lines.push(
    "",
    `Current round: #${roundNumber}`,
    `BTC/USD: ${formatBtcPrice(
      input.snapshot.pricing.eventThreshold ?? input.snapshot.round.eventThreshold
    )}`,
    `↑ UP  ${formatProbabilityPrice(input.snapshot.pricing.upPrice)}   •   ↓ DOWN  ${formatProbabilityPrice(
      input.snapshot.pricing.downPrice
    )}`,
    `Round time left: ${formatRoundCountdown(input.snapshot.round.closingDate)}`,
    `Round closes: ${formatDateTime(input.snapshot.round.closingDate)}`,
    tradeWindowCloseMs === null
      ? "Bot entry window: unavailable"
      : tradeWindowCloseMs > Date.now()
      ? `Bot entry window: ${formatCompactDuration(tradeWindowCloseMs - Date.now())} left`
      : "Bot entry window: closed for this round"
  );

  return lines.join("\n");
}

async function renderArenaLiveView(
  ctx: Context,
  telegramId: number,
  code: string,
  options?: { spectating?: boolean }
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const snapshot =
    view.game.status === "active" && Date.parse(view.game.end_at) > Date.now()
      ? await getCurrentRoundSnapshot("BTC")
      : null;

  await editTradePromptMessage(
    ctx,
    buildArenaLiveText({
      view,
      snapshot,
      spectating: options?.spectating,
    }),
    buildArenaLiveKeyboard({
      code: view.game.code,
      canCatchUp: Boolean(view.me && view.me.place > 1),
      marketUrl: snapshot?.pricing?.url,
    })
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

async function renderArenaBoardView(
  ctx: Context,
  telegramId: number,
  code: string,
  options?: { spectating?: boolean }
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const text = await getFantasyLeagueBoardText(code, telegramId);

  await editTradePromptMessage(
    ctx,
    options?.spectating ? ["👀 Spectating", "", text].join("\n") : text,
    buildArenaBoardKeyboard({
      code: view.game.code,
      canCatchUp: Boolean(view.me && view.me.place > 1),
    })
  );
}

async function renderCatchUpView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const leader = view.leaderboard[0] ?? null;

  if (!view.me || !leader || leader.telegram_id === telegramId) {
    await renderArenaBoardView(ctx, telegramId, code);
    return;
  }

  const gap = Math.max(0, leader.virtual_balance - view.me.virtual_balance);
  const suggestedStake = 100;
  const requiredReturnMultiple = gap / suggestedStake + 1;

  await editTradePromptMessage(
    ctx,
    buildCatchUpText({
      code,
      leaderName: anonymizePlayer(leader.telegram_id, telegramId),
      gap,
      suggestedStake,
      requiredReturnMultiple,
    }),
    new InlineKeyboard()
      .text("Back to leaderboard", `arena:board:${code}`)
      .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY)
  );
}

async function renderArenaWatchView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  await renderArenaLiveView(ctx, telegramId, code, { spectating: true });
}

async function getArenaInviteShareUrl(
  ctx: Context,
  input: { code: string; entryFee: number }
): Promise<string | undefined> {
  try {
    const me = await ctx.api.getMe();

    if (!me.username) {
      return undefined;
    }

    return buildShareInviteUrl({
      botUsername: me.username,
      code: input.code,
      entryFee: input.entryFee,
    });
  } catch (error) {
    console.warn("[bot] Failed to build arena invite share URL:", error);
    return undefined;
  }
}

async function renderCreateArenaDurationPicker(
  ctx: Context,
  telegramId: number,
  entryFee: number
): Promise<void> {
  const balance = await getBalance(telegramId);

  await editTradePromptMessage(
    ctx,
    buildCreateArenaDurationText({
      balance,
      entryFee,
    }),
    buildCreateArenaDurationKeyboard(entryFee)
  );
}

async function createArenaFromSelection(
  ctx: Context,
  telegramId: number,
  entryFee: number,
  durationHours: number
): Promise<void> {
  const game = await createFantasyLeagueGame(telegramId, entryFee, durationHours);
  const shareUrl = await getArenaInviteShareUrl(ctx, {
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
      durationHours: getGameDurationHours(game),
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

  const balance = await getBalance(ctx.from.id);

  await ctx.reply(
    buildStartOnboardingText({
      firstName: ctx.from.first_name?.trim() || "there",
      balance,
    }),
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildStartOnboardingKeyboard(),
    }
  );
}

export async function handleFantasyLeagueUiAction(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery?.data) {
    return;
  }

  const data = ctx.callbackQuery.data;

  if (data === START_HOW_IT_WORKS) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(ctx, buildHowItWorksText(), buildHowItWorksKeyboard());
    return;
  }

  if (data === START_WALLET || data === WALLET_OPEN) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === START_LOBBY || data === LOBBY_REFRESH || data === ARENA_BACK_TO_LOBBY) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await openLobbyOrFundingPrompt(ctx, ctx.from.id);
    return;
  }

  if (data.startsWith(ARENA_TRADE_PREFIX)) {
    try {
      const prompt = await prepareFantasyTradePromptForArena({
        telegramId: ctx.from.id,
        code: data.slice(ARENA_TRADE_PREFIX.length),
      });
      const sent = await ctx.reply(prompt.text, {
        reply_markup: prompt.keyboard,
      });

      registerFantasyTradePromptDelivery({
        chatId: sent.chat.id,
        messageId: sent.message_id,
        telegramId: ctx.from.id,
        state: prompt.state,
      });
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data === LOBBY_LIVE) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await openLobbyOrFundingPrompt(ctx, ctx.from.id, { liveOnly: true });
    return;
  }

  if (data === FUNDS_ADD) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === FUNDS_CUSTOM) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(ctx, buildWalletWithdrawHelpText(), buildWalletKeyboard());
    return;
  }

  if (data === FUNDS_BACK_TO_LOBBY || data === WALLET_BACK) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await openLobbyOrFundingPrompt(ctx, ctx.from.id);
    return;
  }

  if (data === WALLET_REFRESH || data.startsWith("funds:amount:")) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === WALLET_WITHDRAW_HELP) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(ctx, buildWalletWithdrawHelpText(), buildWalletKeyboard());
    return;
  }

  if (data === WALLET_CROSS_CHAIN) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(ctx, buildWalletCrossChainHelpText(), buildWalletKeyboard());
    return;
  }

  if (data === WALLET_NAIRA_HELP) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildWalletNairaHelpText(),
      buildWalletNairaPickerKeyboard()
    );
    return;
  }

  if (data === WALLET_NAIRA_CUSTOM) {
    await savePendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildWalletNairaCustomAmountText(),
      buildWalletNairaCustomAmountKeyboard()
    );
    return;
  }

  if (data === WALLET_NAIRA_BACK) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data.startsWith(WALLET_NAIRA_AMOUNT_PREFIX)) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);

    const amount = Number.parseFloat(data.slice(WALLET_NAIRA_AMOUNT_PREFIX.length));
    const amountError = getWalletNairaAmountError(amount);

    if (amountError) {
      await editTradePromptMessage(
        ctx,
        amountError,
        buildWalletNairaPickerKeyboard()
      );
      return;
    }

    try {
      const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
      await editTradePromptMessage(ctx, orderText, buildWalletNairaOrderKeyboard());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await editTradePromptMessage(
        ctx,
        message,
        buildWalletNairaPickerKeyboard()
      );
    }

    return;
  }

  if (data === ARENA_CREATE) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const balance = await getBalance(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildCreateArenaPickerText(balance),
      buildCreateArenaPickerKeyboard(ctx.from.id)
    );
    return;
  }

  if (data === OFFRAMP_CANCEL) {
    await clearOfframpSession(ctx.from.id);
    await ctx.editMessageText("Offramp cancelled.").catch(() => null);
    return;
  }

  if (data.startsWith("offramp:bank:")) {
    const parts = data.slice("offramp:bank:".length).split(":");
    const bankId = parts[0] ?? "";
    const bankName = parts.slice(1).join(":") || bankId;

    const session = await loadOfframpSession(ctx.from.id);

    if (!session?.accountNumber) {
      await ctx.editMessageText("Session expired. Please try /offrampngn again.").catch(() => null);
      return;
    }

    try {
      const confirmation = await confirmBankAccount({ bankId, accountNumber: session.accountNumber });
      const accountName = confirmation.accountName;

      await saveOfframpSession(ctx.from.id, {
        step: "awaiting_usdc_amount",
        bankId,
        bankName: confirmation.bank?.name ?? bankName,
        accountNumber: session.accountNumber,
        accountName,
      });

      await ctx.editMessageText(
        [
          `Account: ${accountName}`,
          `Account number: ${session.accountNumber}`,
          `Bank: ${confirmation.bank?.name ?? bankName}`,
          "",
          `Enter USDC amount to offramp (minimum ${formatUsdc(PAJCASH_OFFRAMP_MIN_USDC)}):`,
        ].join("\n"),
        { reply_markup: buildOfframpCancelKeyboard() }
      ).catch(() =>
        ctx.reply(
          `Account confirmed: ${accountName}\n\nEnter USDC amount (minimum ${formatUsdc(PAJCASH_OFFRAMP_MIN_USDC)}):`,
          { reply_markup: buildOfframpCancelKeyboard() }
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not confirm account.";
      await ctx.editMessageText(message, { reply_markup: buildOfframpCancelKeyboard() }).catch(() =>
        ctx.reply(message, { reply_markup: buildOfframpCancelKeyboard() })
      );
    }

    return;
  }

  if (data === OFFRAMP_CONFIRM) {
    const session = await loadOfframpSession(ctx.from.id);
    await clearOfframpSession(ctx.from.id);

    if (
      !session ||
      session.step !== "pending_confirm" ||
      !session.bankId ||
      !session.accountNumber ||
      !session.usdcAmount
    ) {
      await ctx.editMessageText("Session expired. Please try /offrampngn again.").catch(() => null);
      return;
    }

    try {
      const order = await createFantasyPajCashOfframp({
        telegramId: ctx.from.id,
        bankId: session.bankId,
        accountNumber: session.accountNumber,
        usdcAmount: session.usdcAmount,
      });

      const resultText = buildOfframpOrderText({
        orderId: order.order_id,
        usdcAmount: order.expected_usdc_amount,
        fiatAmount: order.fiat_amount,
        accountName: session.accountName ?? session.accountNumber,
        accountNumber: session.accountNumber,
        bankName: session.bankName ?? session.bankId,
        depositAddress: order.recipient_address ?? "",
      });

      await ctx.editMessageText(resultText, { reply_markup: buildWalletKeyboard() }).catch(() =>
        ctx.reply(resultText, { reply_markup: buildWalletKeyboard() })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await ctx.editMessageText(message, { reply_markup: buildWalletKeyboard() }).catch(() =>
        ctx.reply(message, { reply_markup: buildWalletKeyboard() })
      );
    }

    return;
  }

  if (data === ARENA_CREATE_CUSTOM) {
    if (!isDevUser(ctx.from.id)) {
      await ctx.answerCallbackQuery("Not available.");
      return;
    }
    await savePendingCustomArenaFee(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      "Type your custom entry fee (e.g. 0.20):",
      new InlineKeyboard().text("Cancel", ARENA_CREATE)
    );
    return;
  }

  if (data.startsWith("arena:create:")) {
    const entryFee = Number.parseFloat(data.slice("arena:create:".length));

    if (!Number.isFinite(entryFee)) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    await renderCreateArenaDurationPicker(ctx, ctx.from.id, entryFee);
    return;
  }

  if (data.startsWith(ARENA_DURATION_PREFIX)) {
    const [entryFeeRaw, durationHoursRaw] = data
      .slice(ARENA_DURATION_PREFIX.length)
      .split(":");
    const entryFee = Number.parseFloat(entryFeeRaw ?? "");
    const durationHours = Number.parseInt(durationHoursRaw ?? "", 10);

    if (!Number.isFinite(entryFee) || !Number.isInteger(durationHours)) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    try {
      await createArenaFromSelection(ctx, ctx.from.id, entryFee, durationHours);
    } catch (error) {
      await replyFantasyCreateError(ctx, error, entryFee);
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

  if (data.startsWith(ARENA_LIVE_PREFIX)) {
    try {
      await renderArenaLiveView(ctx, ctx.from.id, data.slice(ARENA_LIVE_PREFIX.length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
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
      await renderArenaBoardView(ctx, ctx.from.id, data.slice("arena:board:".length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith(ARENA_REFRESH_PREFIX)) {
    try {
      await renderArenaBoardView(ctx, ctx.from.id, data.slice(ARENA_REFRESH_PREFIX.length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith(ARENA_CATCH_UP_PREFIX)) {
    try {
      await renderCatchUpView(ctx, ctx.from.id, data.slice(ARENA_CATCH_UP_PREFIX.length));
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

  if (data.startsWith(ARENA_REMIND_PREFIX)) {
    const code = data.slice(ARENA_REMIND_PREFIX.length);
    const confirmMsg = await ctx.reply(
      "Locked in. I'll nudge you when the next round opens."
    ).catch(() => null);
    const saved = await saveFantasyNextRoundReminder(
      ctx.from.id,
      code,
      confirmMsg?.message_id
    );
    if (!saved) {
      if (confirmMsg) {
        await ctx.api.deleteMessage(ctx.chat!.id, confirmMsg.message_id).catch(() => undefined);
      }
      await ctx.reply("I couldn't set a reminder for that arena.");
    }
    return;
  }
}

export async function handleFantasyTextInput(ctx: Context): Promise<boolean> {
  if (!ctx.from) {
    return false;
  }

  const messageText = (ctx.message?.text ?? "").trim();
  if (!messageText || messageText.startsWith("/")) {
    return false;
  }

  // Custom arena entry fee (dev users only)
  if (await hasPendingCustomArenaFee(ctx.from.id)) {
    const fee = Number.parseFloat(messageText.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(fee) || fee <= 0) {
      await ctx.reply("Enter a valid amount, e.g. 0.20");
      return true;
    }
    await clearPendingCustomArenaFee(ctx.from.id);
    const balance = await getBalance(ctx.from.id);
    await ctx.reply(
      buildCreateArenaDurationText({ balance, entryFee: fee }),
      { reply_markup: buildCreateArenaDurationKeyboard(fee) }
    );
    return true;
  }

  // Offramp session handling
  const offrampSession = await loadOfframpSession(ctx.from.id);

  if (offrampSession) {
    if (offrampSession.step === "awaiting_bank_account") {
      const accountNumber = messageText.replace(/\D/g, "");

      if (accountNumber.length < 10) {
        await ctx.reply("Enter a valid 10-digit bank account number.", {
          reply_markup: buildOfframpCancelKeyboard(),
        });
        return true;
      }

      // Fetch banks and confirm account
      try {
        const banks = await getBanks();

        if (banks.length === 0) {
          await ctx.reply("No banks available right now. Please try again later.", {
            reply_markup: buildOfframpCancelKeyboard(),
          });
          return true;
        }

        // We need the user to pick a bank — show a simplified prompt
        // Store account number and ask for bank selection via inline keyboard
        await saveOfframpSession(ctx.from.id, {
          step: "awaiting_bank_account",
          accountNumber,
        });

        const bankButtons = banks.slice(0, 20); // cap at 20 to avoid oversized keyboard
        const keyboard = new InlineKeyboard();

        for (let i = 0; i < bankButtons.length; i += 2) {
          const row = bankButtons.slice(i, i + 2);
          for (const bank of row) {
            keyboard.text(bank.name, `offramp:bank:${bank.id}:${bank.name.slice(0, 20)}`);
          }
          keyboard.row();
        }

        keyboard.text("❌ Cancel", OFFRAMP_CANCEL);

        await ctx.reply(`Account number: ${accountNumber}\n\nSelect your bank:`, {
          reply_markup: keyboard,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Something went wrong.";
        await ctx.reply(message, { reply_markup: buildOfframpCancelKeyboard() });
      }

      return true;
    }

    if (offrampSession.step === "awaiting_usdc_amount") {
      const usdcAmount = Number.parseFloat(messageText.replace(/[^0-9.]/g, ""));

      if (!Number.isFinite(usdcAmount) || usdcAmount < PAJCASH_OFFRAMP_MIN_USDC) {
        await ctx.reply(
          `Enter a valid USDC amount (minimum ${formatUsdc(PAJCASH_OFFRAMP_MIN_USDC)}).`,
          { reply_markup: buildOfframpCancelKeyboard() }
        );
        return true;
      }

      const balance = await getBalance(ctx.from.id);

      if (balance < usdcAmount) {
        await ctx.reply(
          `Insufficient balance. Available: ${formatUsdc(balance)}`,
          { reply_markup: buildOfframpCancelKeyboard() }
        );
        return true;
      }

      await saveOfframpSession(ctx.from.id, {
        ...offrampSession,
        step: "pending_confirm",
        usdcAmount,
      });

      await ctx.reply(
        [
          "Confirm offramp:",
          "",
          `Account: ${offrampSession.accountName}`,
          `Account number: ${offrampSession.accountNumber}`,
          `Bank: ${offrampSession.bankName}`,
          `USDC to debit: ${formatUsdc(usdcAmount)}`,
          "",
          "Your balance will be debited immediately.",
        ].join("\n"),
        { reply_markup: buildOfframpConfirmKeyboard() }
      );

      return true;
    }
  }

  if (!(await hasPendingFantasyCustomFundAmount(ctx.from.id))) {
    return false;
  }

  const amount = parseWalletNairaAmountInput(messageText);

  if (amount === null) {
    await ctx.reply(buildWalletNairaCustomAmountText(), {
      reply_markup: buildWalletNairaCustomAmountKeyboard(),
    });
    return true;
  }

  const amountError = getWalletNairaAmountError(amount);

  if (amountError) {
    await ctx.reply(amountError, {
      reply_markup: buildWalletNairaCustomAmountKeyboard(),
    });
    return true;
  }

  try {
    const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await ctx.reply(orderText, {
      reply_markup: buildWalletNairaOrderKeyboard(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await ctx.reply(message, {
      reply_markup: buildWalletNairaCustomAmountKeyboard(),
    });
  }

  return true;
}

export async function handleWallet(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "address" || subcommand === "refresh") {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (subcommand === "withdraw") {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const amount = Number.parseFloat(args[1] ?? "");
    const destinationAddress = args[2]?.trim() ?? "";

    if (!Number.isFinite(amount) || amount <= 0 || !destinationAddress) {
      await ctx.reply(buildWalletWithdrawHelpText(), {
        reply_markup: buildWalletKeyboard(),
      });
      return;
    }

    if (!isValidSolanaAddress(destinationAddress)) {
      await ctx.reply("That Solana address looks invalid. Please check it and try again.");
      return;
    }

    try {
      await requestFantasyWalletWithdrawal({
        telegramId: ctx.from.id,
        destinationAddress,
        amount,
      });
      await processFantasyWalletWithdrawals();
      await ctx.reply(
        buildWalletWithdrawalRequestedText({
          amount,
          destinationAddress,
        }),
        {
          reply_markup: buildWalletKeyboard(),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      const normalized = message.toLowerCase();

      if (normalized.includes("insufficient wallet balance")) {
        const balance = await getBalance(ctx.from.id);
        await ctx.reply(buildArenaInsufficientBalanceText(amount, balance), {
          reply_markup: buildInsufficientBalanceKeyboard(),
        });
        return;
      }

      await ctx.reply(message);
    }

    return;
  }

  if (subcommand === "deposit-cross") {
    // Usage: /wallet deposit-cross <chainId> <tokenAddress> <amountRaw>
    const originChainId = args[1]?.trim() ?? "";
    const originAsset = args[2]?.trim() ?? "";
    const amountRaw = args[3]?.trim() ?? "";

    if (!originChainId || !originAsset || !amountRaw || !/^\d+$/.test(amountRaw)) {
      await ctx.reply(buildWalletCrossChainHelpText(), {
        reply_markup: buildWalletKeyboard(),
      });
      return;
    }

    try {
      const result = await createCrossChainDeposit({
        telegramId: ctx.from.id,
        originChainId,
        originAsset,
        originSymbol: originAsset.length > 10 ? originAsset.slice(0, 6) + "…" : originAsset,
        amountRaw,
      });
      await ctx.reply(
        buildWalletCrossChainResultText({
          depositAddress: result.depositAddress,
          depositRequestId: result.depositRequestId,
          originSymbol: originAsset,
          expectedUsdcOut: result.expectedUsdcOut,
          expiresInSeconds: result.expiresInSeconds,
        }),
        { reply_markup: buildWalletKeyboard() }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await ctx.reply(`Cross-chain deposit failed: ${message}`, {
        reply_markup: buildWalletKeyboard(),
      });
    }

    return;
  }

  if (subcommand === "deposit-cross") {
    const originChainId = args[1]?.trim() ?? "";
    const originAsset = args[2]?.trim() ?? "";
    const humanAmount = args[3]?.trim() ?? "";
    const decimals = Number.parseInt(args[4]?.trim() ?? "6", 10);

    if (!originChainId || !originAsset || !humanAmount || !Number.isFinite(Number(humanAmount)) || Number(humanAmount) <= 0) {
      await ctx.reply(buildWalletCrossChainHelpText(), { reply_markup: buildWalletKeyboard() });
      return;
    }

    // Convert human amount to smallest unit
    const amountRaw = BigInt(Math.round(Number(humanAmount) * 10 ** decimals)).toString();

    try {
      const result = await createCrossChainDeposit({
        telegramId: ctx.from.id,
        originChainId,
        originAsset,
        originSymbol: originAsset,
        amountRaw,
      });
      await ctx.reply(
        buildWalletCrossChainResultText({
          depositAddress: result.depositAddress,
          depositRequestId: result.depositRequestId,
          originSymbol: originAsset,
          expectedUsdcOut: result.expectedUsdcOut,
          expiresInSeconds: result.expiresInSeconds,
        }),
        { reply_markup: buildWalletKeyboard() }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await ctx.reply(`Cross-chain deposit failed: ${message}`, { reply_markup: buildWalletKeyboard() });
    }

    return;
  }

  if (subcommand === "fund-ngn") {
    const amount = Number.parseFloat(args[1] ?? "");
    const amountError = getWalletNairaAmountError(amount);

    if (amountError) {
      await ctx.reply(amountError, {
        reply_markup: buildWalletNairaPickerKeyboard(),
      });
      return;
    }

    try {
      await clearPendingFantasyCustomFundAmount(ctx.from.id);
      const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
      await ctx.reply(orderText, {
        reply_markup: buildWalletNairaOrderKeyboard(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await ctx.reply(message, {
        reply_markup: buildWalletNairaPickerKeyboard(),
      });
    }

    return;
  }

  await ctx.reply(buildWalletCommandHelpText(), {
    reply_markup: buildWalletKeyboard(),
  });
}

// ── Offramp (USDC → NGN) ─────────────────────────────────────────────────────

function buildOfframpHelpText(): string {
  return [
    "💸 Offramp USDC → Naira",
    "",
    `Minimum: ${PAJCASH_OFFRAMP_MIN_USDC} USDC`,
    "",
    "Step 1: Enter your Nigerian bank account number.",
    "Step 2: Confirm the account name.",
    "Step 3: Enter the USDC amount to offramp.",
    "",
    "Your in-bot balance will be debited immediately.",
    "PajCash will send Naira to your bank account.",
  ].join("\n");
}

function buildOfframpCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel", OFFRAMP_CANCEL);
}

function buildOfframpConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", OFFRAMP_CONFIRM)
    .text("❌ Cancel", OFFRAMP_CANCEL);
}

function buildOfframpOrderText(input: {
  orderId: string;
  usdcAmount: number;
  fiatAmount: number;
  accountName: string;
  accountNumber: string;
  bankName: string;
  depositAddress: string;
}): string {
  return [
    "✅ Offramp order created.",
    "",
    `Order ID: ${input.orderId}`,
    `USDC debited: ${formatUsdc(input.usdcAmount)}`,
    `Naira to receive: ${formatNaira(input.fiatAmount)}`,
    "",
    "Sending to:",
    `${input.accountName}`,
    `${input.accountNumber}`,
    `${input.bankName}`,
    "",
    "PajCash will send the Naira to your bank account after receiving the USDC.",
  ].join("\n");
}

export async function handleOfframpNgn(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  await clearOfframpSession(ctx.from.id);
  await clearPendingFantasyCustomFundAmount(ctx.from.id);

  const balance = await getBalance(ctx.from.id);

  if (balance < PAJCASH_OFFRAMP_MIN_USDC) {
    await ctx.reply(
      [
        `Insufficient balance. You need at least ${formatUsdc(PAJCASH_OFFRAMP_MIN_USDC)} to offramp.`,
        `Your balance: ${formatUsdc(balance)}`,
      ].join("\n"),
      { reply_markup: buildWalletKeyboard() }
    );
    return;
  }

  await saveOfframpSession(ctx.from.id, { step: "awaiting_bank_account" });
  await ctx.reply(
    [
      buildOfframpHelpText(),
      "",
      "Enter your bank account number:",
    ].join("\n"),
    { reply_markup: buildOfframpCancelKeyboard() }
  );
}

export async function handleFundNgn(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const amount = Number.parseFloat((ctx.message?.text ?? "").split(/\s+/)[1] ?? "");
  const amountError = getWalletNairaAmountError(amount);

  if (amountError) {
    await ctx.reply(amountError, {
      reply_markup: buildWalletNairaPickerKeyboard(),
    });
    return;
  }

  try {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
    await ctx.reply(orderText, {
      reply_markup: buildWalletNairaOrderKeyboard(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await ctx.reply(message, {
      reply_markup: buildWalletNairaPickerKeyboard(),
    });
  }
}

export async function handleWithdraw(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const amount = Number.parseFloat(args[0] ?? "");
  const destinationAddress = args[1]?.trim() ?? "";

  if (!Number.isFinite(amount) || amount <= 0 || !destinationAddress) {
    await ctx.reply(buildWalletWithdrawHelpText(), {
      reply_markup: buildWalletKeyboard(),
    });
    return;
  }

  if (!isValidSolanaAddress(destinationAddress)) {
    await ctx.reply("That Solana address looks invalid. Please check it and try again.");
    return;
  }

  try {
    await requestFantasyWalletWithdrawal({
      telegramId: ctx.from.id,
      destinationAddress,
      amount,
    });
    await processFantasyWalletWithdrawals();
    await ctx.reply(
      buildWalletWithdrawalRequestedText({
        amount,
        destinationAddress,
      }),
      {
        reply_markup: buildWalletKeyboard(),
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    const normalized = message.toLowerCase();

    if (normalized.includes("insufficient wallet balance")) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(buildArenaInsufficientBalanceText(amount, balance), {
        reply_markup: buildInsufficientBalanceKeyboard(),
      });
      return;
    }

    await ctx.reply(message);
  }
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(buildLeagueHelpText(), {
    ...(buildChartCommandKeyboard()
      ? { reply_markup: buildChartCommandKeyboard() }
      : {}),
  });
}

export async function handleChart(ctx: Context): Promise<void> {
  await replyChartCommand(ctx);
}

export async function handleCreate(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "create");
}

export async function handleJoin(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "join");
}

export async function handleLive(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "live");
}

export async function handleBoard(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "board");
}

export async function handleStatus(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "status");
}

async function handleLeagueAlias(
  ctx: Context,
  subcommand: "create" | "join" | "live" | "board" | "status"
): Promise<void> {
  const messageText = ctx.message?.text ?? "";
  const command = messageText.split(/\s+/)[0] ?? "";
  const args = messageText.slice(command.length).trim();

  if (ctx.message) {
    ctx.message.text = `/league ${subcommand}${args ? ` ${args}` : ""}`;
  }

  await handleLeague(ctx);
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
    const durationHours = Number.parseInt(args[2] ?? "", 10);

    if (!Number.isFinite(entryFee)) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(buildCreateArenaPickerText(balance), {
        reply_markup: buildCreateArenaPickerKeyboard(ctx.from.id),
      });
      return;
    }

    if (!Number.isInteger(durationHours)) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(
        buildCreateArenaDurationText({
          balance,
          entryFee,
        }),
        {
          reply_markup: buildCreateArenaDurationKeyboard(entryFee),
        }
      );
      return;
    }

    try {
      const game = await createFantasyLeagueGame(ctx.from.id, entryFee, durationHours);
      const shareUrl = await getArenaInviteShareUrl(ctx, {
        code: game.code,
        entryFee: game.entry_fee,
      });

      await ctx.reply(
        buildFantasyCreateSuccessText({
          code: game.code,
          prizePool: game.prize_pool,
          virtualStack: game.virtual_start_balance,
          roundsUntilStart: getApproxRoundsUntil(game.start_at),
          durationHours: getGameDurationHours(game),
        }),
        {
          reply_markup: buildFantasyCreateSuccessKeyboard(shareUrl),
        }
      );
    } catch (error) {
      await replyFantasyCreateError(ctx, error, entryFee);
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

  if (subcommand === "live") {
    const code = await resolveArenaLiveCode(ctx.from.id, args[1]);

    if (!code) {
      await ctx.reply("Usage: /league live ABC123");
      return;
    }

    try {
      const view = await getFantasyLeagueStatusView(ctx.from.id, code);
      const snapshot =
        view.game.status === "active" && Date.parse(view.game.end_at) > Date.now()
          ? await getCurrentRoundSnapshot("BTC")
          : null;

      await ctx.reply(
        buildArenaLiveText({
          view,
          snapshot,
        }),
        {
          reply_markup: buildArenaLiveKeyboard({
            code,
            canCatchUp: Boolean(view.me && view.me.place > 1),
            marketUrl: snapshot?.pricing?.url,
          }),
        }
      );
    } catch (error) {
      await replyArenaLookupError(ctx, error);
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
      const view = await getFantasyLeagueStatusView(ctx.from.id, code);
      await ctx.reply(await getFantasyLeagueBoardText(code, ctx.from.id), {
        reply_markup: buildArenaBoardKeyboard({
          code,
          canCatchUp: Boolean(view.me && view.me.place > 1),
        }),
      });
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
      const view = await getFantasyLeagueStatusView(ctx.from.id, code);
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

      await ctx.reply(
        [
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
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text("Full leaderboard", `arena:board:${view.game.code}`)
            .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY),
        }
      );
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

  if (callbackData.startsWith("flt:b:")) {
    try {
      const directionSelection = await buildFantasyTradeStakeSelection({
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
    const shareUrl = await getArenaInviteShareUrl(ctx, {
      code: game.code,
      entryFee: game.entry_fee,
    });

    await editTradePromptMessage(
      ctx,
      buildFantasyJoinSuccessText({
        code: game.code,
        virtualBalance: game.virtual_start_balance,
        playBalance: balance,
        prizePool: leaderboard.game.prize_pool,
        playerCount: leaderboard.memberCount,
        roundsUntilStart: getApproxRoundsUntil(game.start_at),
        durationHours: getGameDurationHours(game),
      }),
      buildFantasyJoinSuccessKeyboard(shareUrl)
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


export async function handleAdminWithdraw(ctx: Context): Promise<void> {
  if (!ctx.from) return
  if (ctx.from.id !== Number(process.env.ADMIN_USER_ID)) {
    await ctx.reply("Unauthorized.")
    return
  }
  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1)
  const amount = Number.parseFloat(args[0] ?? "")
  const destination = args[1]?.trim() ?? ""
  if (!Number.isFinite(amount) || amount < 0.5 || !destination) {
    await ctx.reply("Usage: /adminwithdraw <amount> <solana_address>\nMinimum: $0.50")
    return
  }
  try {
    const result = await transferTreasuryUsdc({ destinationAddress: destination, amount })
    await ctx.reply(`Sent $${amount} USDC to ${destination}\nSignature: ${result.signature}`)
  } catch (error) {
    await ctx.reply(`Transfer failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
