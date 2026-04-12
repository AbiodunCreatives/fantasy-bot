import { createHash } from "crypto";

import type { FantasyGame, FantasyLeaderboardEntry } from "./db/fantasy.js";

export const ARENA_ENTRY_FEE_OPTIONS = [1, 2, 5, 10] as const;

export interface PrizeAwardPreview {
  amount: number;
  place: number;
  telegramId: number;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatMoney(
  value: number,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }
): string {
  return `$${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  })}`;
}

export function formatWholeMoney(value: number): string {
  return formatMoney(value, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function formatSignedPercent(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  const prefix = rounded > 0 ? "+" : rounded < 0 ? "" : "";
  return `${prefix}${rounded.toFixed(1)}%`;
}

export function formatCompactDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalMinutes = Math.floor(safeMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${Math.max(1, minutes)}m`;
  }

  return `${hours}h ${minutes}m`;
}

export function formatRoundCountdown(targetIso: string): string {
  const secondsRemaining = Math.max(
    0,
    Math.floor((Date.parse(targetIso) - Date.now()) / 1000)
  );
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatMediumDateTime(value: string): string {
  const date = new Date(value);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })} ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function formatBtcPrice(value: number | null | undefined): string {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${Math.round(value ?? 0).toLocaleString("en-US")}`;
}

export function formatProbabilityPrice(value: number): string {
  return roundMoney(value).toFixed(2);
}

export function getVirtualReturnPct(
  game: FantasyGame,
  virtualBalance: number
): number {
  if (game.virtual_start_balance <= 0) {
    return 0;
  }

  return (
    ((roundMoney(virtualBalance) - game.virtual_start_balance) /
      game.virtual_start_balance) *
    100
  );
}

export function anonymizePlayer(
  telegramId: number,
  viewerTelegramId?: number
): string {
  if (viewerTelegramId !== undefined && telegramId === viewerTelegramId) {
    return "you";
  }

  const digest = createHash("sha256")
    .update(String(telegramId))
    .digest("hex")
    .slice(0, 3);

  return `anon_${digest}`;
}

export function getApproxRoundsUntil(startAt: string): number {
  const ms = Math.max(0, Date.parse(startAt) - Date.now());
  return Math.max(0, Math.ceil(ms / (15 * 60 * 1000)));
}

export function getApproxRoundsLeft(endAt: string): number {
  const ms = Math.max(0, Date.parse(endAt) - Date.now());
  return Math.max(0, Math.ceil(ms / (15 * 60 * 1000)));
}

export function getGameRoundNumber(game: FantasyGame, roundOpeningDate: string): number {
  const elapsedMs = Date.parse(roundOpeningDate) - Date.parse(game.start_at);
  return Math.max(1, Math.floor(elapsedMs / (15 * 60 * 1000)) + 1);
}

export function formatRankMovement(
  previousRank: number | null,
  nextRank: number
): string {
  if (previousRank === null) {
    return `#${nextRank}`;
  }

  if (previousRank === nextRank) {
    return `#${nextRank}  (unchanged)`;
  }

  if (nextRank < previousRank) {
    return `#${nextRank} ↑  (was #${previousRank})`;
  }

  return `#${nextRank} ↓  (was #${previousRank})`;
}

export function getPrizeSplits(playerCount: number): number[] {
  if (playerCount <= 1) {
    return [1];
  }

  if (playerCount === 2) {
    return [0.6, 0.4];
  }

  return [0.5, 0.3, 0.2];
}

function areEntriesExactlyTied(
  left: FantasyLeaderboardEntry,
  right: FantasyLeaderboardEntry
): boolean {
  return (
    roundMoney(left.virtual_balance) === roundMoney(right.virtual_balance) &&
    roundMoney(left.accuracy_pct) === roundMoney(right.accuracy_pct) &&
    left.wins === right.wins &&
    left.losses === right.losses
  );
}

export function getPrizeAwardPreview(
  leaderboard: FantasyLeaderboardEntry[],
  prizePool: number
): PrizeAwardPreview[] {
  const splits = getPrizeSplits(leaderboard.length);
  const awards: PrizeAwardPreview[] = [];

  for (let index = 0; index < leaderboard.length && index < splits.length; ) {
    const group = [leaderboard[index]!];
    let cursor = index + 1;

    while (
      cursor < leaderboard.length &&
      areEntriesExactlyTied(leaderboard[index]!, leaderboard[cursor]!)
    ) {
      group.push(leaderboard[cursor]!);
      cursor += 1;
    }

    const relevantSplits = splits.slice(index, index + group.length);
    const combinedShare = relevantSplits.reduce((sum, share) => sum + share, 0);

    if (combinedShare > 0) {
      const amountEach = roundMoney((prizePool * combinedShare) / group.length);

      for (const entry of group) {
        awards.push({
          telegramId: entry.telegram_id,
          place: index + 1,
          amount: amountEach,
        });
      }
    }

    index = cursor;
  }

  return awards;
}

export function getProjectedPrizeForUser(
  leaderboard: FantasyLeaderboardEntry[],
  prizePool: number,
  telegramId: number
): number {
  return (
    getPrizeAwardPreview(leaderboard, prizePool).find(
      (award) => award.telegramId === telegramId
    )?.amount ?? 0
  );
}

function normalizeBotUsername(botUsername: string): string {
  return botUsername.replace(/^@/, "").trim();
}

export function buildShareInviteUrl(input: {
  botUsername: string;
  code: string;
  entryFee: number;
}): string {
  const username = normalizeBotUsername(input.botUsername);
  const deepLink = `https://t.me/${username}?start=${encodeURIComponent(input.code)}`;
  const text =
    `I just created a ${formatMoney(input.entryFee, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })} arena on Bayse Arena.\n\n` +
    `Join with code ${input.code} - best bankroll takes the pot.\n` +
    `👉 t.me/${username}?start=${input.code}`;

  const shareUrl = new URL("https://t.me/share/url");
  shareUrl.searchParams.set("url", deepLink);
  shareUrl.searchParams.set("text", text);
  return shareUrl.toString();
}

export function buildShareResultUrl(input: {
  botUsername: string;
  entryFee: number;
  finishPlace: number;
  fieldSize: number;
  returnPct: number;
  leaderReturnPct: number;
}): string {
  const username = normalizeBotUsername(input.botUsername);
  const deepLink = `https://t.me/${username}`;
  const text =
    `Just finished a ${formatMoney(input.entryFee, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })} arena on Bayse Arena.\n\n` +
    `Finished #${input.finishPlace} of ${input.fieldSize}. ` +
    `${formatSignedPercent(input.returnPct)} virtual return.\n` +
    `1st place did ${formatSignedPercent(input.leaderReturnPct)}.\n\n` +
    `Think you can beat that?\n` +
    `👉 t.me/${username}`;

  const shareUrl = new URL("https://t.me/share/url");
  shareUrl.searchParams.set("url", deepLink);
  shareUrl.searchParams.set("text", text);
  return shareUrl.toString();
}
