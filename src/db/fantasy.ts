import { supabase } from "./client.js";

export type FantasyGameStatus = "open" | "active" | "completed" | "cancelled";
export type FantasyTradeDirection = "UP" | "DOWN";
export type FantasyTradeOutcome = "PENDING" | "WIN" | "LOSS";

export interface FantasyGame {
  id: string;
  code: string;
  creator_telegram_id: number;
  asset: "BTC";
  entry_fee: number;
  virtual_start_balance: number;
  prize_pool: number;
  status: FantasyGameStatus;
  start_at: string;
  end_at: string;
  last_round_event_id: string | null;
  created_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface FantasyGameMember {
  id: string;
  game_id: string;
  telegram_id: number;
  joined_at: string;
  entry_fee_paid: number;
  virtual_balance: number;
  total_trades: number;
  wins: number;
  losses: number;
  prize_awarded: number;
  username?: string | null;
}

export interface FantasyTrade {
  id: string;
  game_id: string;
  member_id: string;
  telegram_id: number;
  event_id: string;
  market_id: string;
  direction: FantasyTradeDirection;
  stake: number;
  entry_price: number;
  shares: number;
  outcome: FantasyTradeOutcome;
  payout: number;
  created_at: string;
  resolved_at: string | null;
}

export interface FantasyLeaderboardEntry {
  place: number;
  telegram_id: number;
  username: string | null;
  virtual_balance: number;
  wins: number;
  losses: number;
  total_trades: number;
  accuracy_pct: number;
  prize_awarded: number;
  joined_at: string;
}

interface FantasyGameRow
  extends Omit<
    FantasyGame,
    "entry_fee" | "virtual_start_balance" | "prize_pool"
  > {
  entry_fee: number | string | null;
  virtual_start_balance: number | string | null;
  prize_pool: number | string | null;
}

interface FantasyGameMemberRow
  extends Omit<
    FantasyGameMember,
    "entry_fee_paid" | "virtual_balance" | "prize_awarded"
  > {
  entry_fee_paid: number | string | null;
  virtual_balance: number | string | null;
  prize_awarded: number | string | null;
}

interface UserNameRow {
  telegram_id: number;
  username: string | null;
}

interface FantasyTradeRow
  extends Omit<FantasyTrade, "stake" | "entry_price" | "shares" | "payout"> {
  stake: number | string | null;
  entry_price: number | string | null;
  shares: number | string | null;
  payout: number | string | null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

function parseMoney(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return roundMoney(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
  }

  return 0;
}

function parseDecimal(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeFantasyGame(row: FantasyGameRow): FantasyGame {
  return {
    ...row,
    entry_fee: parseMoney(row.entry_fee),
    virtual_start_balance: parseMoney(row.virtual_start_balance),
    prize_pool: parseMoney(row.prize_pool),
    last_round_event_id: row.last_round_event_id ?? null,
    completed_at: row.completed_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
  };
}

function normalizeFantasyMember(row: FantasyGameMemberRow): FantasyGameMember {
  return {
    ...row,
    entry_fee_paid: parseMoney(row.entry_fee_paid),
    virtual_balance: parseMoney(row.virtual_balance),
    prize_awarded: parseMoney(row.prize_awarded),
    total_trades: parseCount(row.total_trades),
    wins: parseCount(row.wins),
    losses: parseCount(row.losses),
    username: row.username ?? null,
  };
}

async function attachFantasyMemberUsernames(
  rows: FantasyGameMemberRow[]
): Promise<FantasyGameMember[]> {
  if (rows.length === 0) {
    return [];
  }

  const telegramIds = [...new Set(rows.map((row) => row.telegram_id))];
  const { data, error } = await supabase
    .from("users")
    .select("telegram_id, username")
    .in("telegram_id", telegramIds);

  if (error) {
    throw error;
  }

  const usernamesByTelegramId = new Map<number, string | null>(
    ((data ?? []) as UserNameRow[]).map((row) => [row.telegram_id, row.username])
  );

  return rows.map((row) =>
    normalizeFantasyMember({
      ...row,
      username: usernamesByTelegramId.get(row.telegram_id) ?? row.username ?? null,
    })
  );
}

function normalizeFantasyTrade(row: FantasyTradeRow): FantasyTrade {
  return {
    ...row,
    stake: parseMoney(row.stake),
    entry_price: parseDecimal(row.entry_price),
    shares: parseDecimal(row.shares),
    payout: parseMoney(row.payout),
    resolved_at: row.resolved_at ?? null,
  };
}

export async function createFantasyGame(input: {
  code: string;
  creatorTelegramId: number;
  entryFee: number;
  virtualStartBalance: number;
  startAt: string;
  endAt: string;
}): Promise<FantasyGame> {
  const { data, error } = await supabase
    .from("fantasy_games")
    .insert({
      code: input.code,
      creator_telegram_id: input.creatorTelegramId,
      asset: "BTC",
      entry_fee: roundMoney(input.entryFee),
      virtual_start_balance: roundMoney(input.virtualStartBalance),
      prize_pool: roundMoney(input.entryFee),
      status: "open",
      start_at: input.startAt,
      end_at: input.endAt,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizeFantasyGame(data as FantasyGameRow);
}

export async function getFantasyGameByCode(
  code: string
): Promise<FantasyGame | null> {
  const { data, error } = await supabase
    .from("fantasy_games")
    .select("*")
    .eq("code", code.toUpperCase())
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeFantasyGame(data as FantasyGameRow) : null;
}

export async function getFantasyGameById(
  gameId: string
): Promise<FantasyGame | null> {
  const { data, error } = await supabase
    .from("fantasy_games")
    .select("*")
    .eq("id", gameId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeFantasyGame(data as FantasyGameRow) : null;
}

export async function listUserFantasyGames(
  telegramId: number
): Promise<FantasyGame[]> {
  const { data, error } = await supabase
    .from("fantasy_game_members")
    .select("fantasy_games(*)")
    .eq("telegram_id", telegramId);

  if (error) {
    throw error;
  }

  return (data ?? [])
    .flatMap((row) => {
      const related = (row as { fantasy_games?: FantasyGameRow | FantasyGameRow[] | null })
        .fantasy_games;

      if (!related) {
        return [];
      }

      return Array.isArray(related) ? related : [related];
    })
    .map(normalizeFantasyGame)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export async function listDueOpenFantasyGames(
  nowIso: string
): Promise<FantasyGame[]> {
  const { data, error } = await supabase
    .from("fantasy_games")
    .select("*")
    .eq("status", "open")
    .lte("start_at", nowIso)
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyGame(row as FantasyGameRow));
}

export async function listActiveFantasyGames(
  nowIso: string
): Promise<FantasyGame[]> {
  const { data, error } = await supabase
    .from("fantasy_games")
    .select("*")
    .eq("status", "active")
    .lte("start_at", nowIso)
    .gt("end_at", nowIso)
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyGame(row as FantasyGameRow));
}

export async function listFinalizableFantasyGames(
  nowIso: string
): Promise<FantasyGame[]> {
  const { data, error } = await supabase
    .from("fantasy_games")
    .select("*")
    .eq("status", "active")
    .lte("end_at", nowIso)
    .order("end_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyGame(row as FantasyGameRow));
}

export async function updateFantasyGame(input: {
  gameId: string;
  status?: FantasyGameStatus;
  prizePool?: number;
  lastRoundEventId?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
}): Promise<void> {
  const payload: Record<string, unknown> = {};

  if (input.status) {
    payload.status = input.status;
  }

  if (input.prizePool !== undefined) {
    payload.prize_pool = roundMoney(input.prizePool);
  }

  if (input.lastRoundEventId !== undefined) {
    payload.last_round_event_id = input.lastRoundEventId;
  }

  if (input.completedAt !== undefined) {
    payload.completed_at = input.completedAt;
  }

  if (input.cancelledAt !== undefined) {
    payload.cancelled_at = input.cancelledAt;
  }

  if (Object.keys(payload).length === 0) {
    return;
  }

  const { error } = await supabase
    .from("fantasy_games")
    .update(payload)
    .eq("id", input.gameId);

  if (error) {
    throw error;
  }
}

export async function addFantasyGameMember(input: {
  gameId: string;
  telegramId: number;
  entryFeePaid: number;
  virtualBalance: number;
}): Promise<FantasyGameMember> {
  const { data, error } = await supabase
    .from("fantasy_game_members")
    .insert({
      game_id: input.gameId,
      telegram_id: input.telegramId,
      entry_fee_paid: roundMoney(input.entryFeePaid),
      virtual_balance: roundMoney(input.virtualBalance),
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizeFantasyMember(data as FantasyGameMemberRow);
}

export async function getFantasyGameMember(
  gameId: string,
  telegramId: number
): Promise<FantasyGameMember | null> {
  const { data, error } = await supabase
    .from("fantasy_game_members")
    .select("*")
    .eq("game_id", gameId)
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const [member] = await attachFantasyMemberUsernames([
    data as FantasyGameMemberRow,
  ]);
  return member ?? null;
}

export async function listFantasyGameMembers(
  gameId: string
): Promise<FantasyGameMember[]> {
  const { data, error } = await supabase
    .from("fantasy_game_members")
    .select("*")
    .eq("game_id", gameId)
    .order("joined_at", { ascending: true });

  if (error) {
    throw error;
  }

  return attachFantasyMemberUsernames(
    (data ?? []) as FantasyGameMemberRow[]
  );
}

export async function recalculateFantasyPrizePool(
  gameId: string,
  commissionRate = 0
): Promise<number> {
  const game = await getFantasyGameById(gameId);

  if (!game) {
    throw new Error("Fantasy game not found.");
  }

  const { count, error } = await supabase
    .from("fantasy_game_members")
    .select("*", { count: "exact", head: true })
    .eq("game_id", gameId);

  if (error) {
    throw error;
  }

  const grossPrizePool = roundMoney((count ?? 0) * game.entry_fee);
  const commissionAmount = roundMoney(
    Math.max(0, grossPrizePool * Math.max(0, commissionRate))
  );
  const prizePool = roundMoney(Math.max(0, grossPrizePool - commissionAmount));

  await updateFantasyGame({
    gameId,
    prizePool,
  });

  return prizePool;
}

export async function debitFantasyBalance(
  memberId: string,
  amount: number
): Promise<boolean> {
  const normalizedAmount = roundMoney(amount);

  if (normalizedAmount <= 0) {
    return true;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await supabase
      .from("fantasy_game_members")
      .select("*")
      .eq("id", memberId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return false;
    }

    const member = normalizeFantasyMember(data as FantasyGameMemberRow);
    const nextBalance = roundMoney(member.virtual_balance - normalizedAmount);

    if (nextBalance < 0) {
      return false;
    }

    const { data: updated, error: updateError } = await supabase
      .from("fantasy_game_members")
      .update({ virtual_balance: nextBalance })
      .eq("id", memberId)
      .eq("virtual_balance", member.virtual_balance)
      .select("id");

    if (updateError) {
      throw updateError;
    }

    if ((updated?.length ?? 0) > 0) {
      return true;
    }
  }

  throw new Error("Fantasy balance debit failed after multiple retries.");
}

export async function creditFantasyBalance(
  memberId: string,
  amount: number
): Promise<void> {
  const normalizedAmount = roundMoney(amount);

  if (normalizedAmount <= 0) {
    return;
  }

  const { data, error } = await supabase
    .from("fantasy_game_members")
    .select("*")
    .eq("id", memberId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Fantasy member not found.");
  }

  const member = normalizeFantasyMember(data as FantasyGameMemberRow);
  const nextBalance = roundMoney(member.virtual_balance + normalizedAmount);

  const { error: updateError } = await supabase
    .from("fantasy_game_members")
    .update({ virtual_balance: nextBalance })
    .eq("id", memberId);

  if (updateError) {
    throw updateError;
  }
}

export async function incrementFantasyMemberTradeCount(
  memberId: string
): Promise<void> {
  const { data, error } = await supabase
    .from("fantasy_game_members")
    .select("total_trades")
    .eq("id", memberId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const totalTrades = parseCount(
    (data as { total_trades?: unknown } | null)?.total_trades
  );

  const { error: updateError } = await supabase
    .from("fantasy_game_members")
    .update({ total_trades: totalTrades + 1 })
    .eq("id", memberId);

  if (updateError) {
    throw updateError;
  }
}

export async function recordFantasyTrade(input: {
  gameId: string;
  memberId: string;
  telegramId: number;
  eventId: string;
  marketId: string;
  direction: FantasyTradeDirection;
  stake: number;
  entryPrice: number;
  shares: number;
}): Promise<FantasyTrade> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .insert({
      game_id: input.gameId,
      member_id: input.memberId,
      telegram_id: input.telegramId,
      event_id: input.eventId,
      market_id: input.marketId,
      direction: input.direction,
      stake: roundMoney(input.stake),
      entry_price: input.entryPrice,
      shares: input.shares,
      outcome: "PENDING",
      payout: 0,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizeFantasyTrade(data as FantasyTradeRow);
}

export async function getFantasyTradeForMemberEvent(
  gameId: string,
  memberId: string,
  eventId: string
): Promise<FantasyTrade | null> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .select("*")
    .eq("game_id", gameId)
    .eq("member_id", memberId)
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeFantasyTrade(data as FantasyTradeRow) : null;
}

export async function listPendingFantasyTrades(): Promise<FantasyTrade[]> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .select("*")
    .eq("outcome", "PENDING")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyTrade(row as FantasyTradeRow));
}

export async function listFantasyTradesForGameEvent(
  gameId: string,
  eventId: string
): Promise<FantasyTrade[]> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .select("*")
    .eq("game_id", gameId)
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyTrade(row as FantasyTradeRow));
}

export async function settleFantasyTrade(input: {
  tradeId: string;
  outcome: Exclude<FantasyTradeOutcome, "PENDING">;
  payout: number;
}): Promise<FantasyTrade | null> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .update({
      outcome: input.outcome,
      payout: roundMoney(input.payout),
      resolved_at: new Date().toISOString(),
    })
    .eq("id", input.tradeId)
    .eq("outcome", "PENDING")
    .select("*");

  if (error) {
    throw error;
  }

  const updated = (data ?? [])[0] as FantasyTradeRow | undefined;
  return updated ? normalizeFantasyTrade(updated) : null;
}

export async function reopenFantasyTradeSettlement(input: {
  tradeId: string;
  expectedOutcome: Exclude<FantasyTradeOutcome, "PENDING">;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .update({
      outcome: "PENDING",
      payout: 0,
      resolved_at: null,
    })
    .eq("id", input.tradeId)
    .eq("outcome", input.expectedOutcome)
    .select("id");

  if (error) {
    throw error;
  }

  return (data?.length ?? 0) > 0;
}

export async function applyFantasyTradeSettlement(
  memberId: string,
  input: { outcome: "WIN" | "LOSS"; payout: number }
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await supabase
      .from("fantasy_game_members")
      .select("*")
      .eq("id", memberId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new Error("Fantasy member not found.");
    }

    const member = normalizeFantasyMember(data as FantasyGameMemberRow);
    const nextWins = member.wins + (input.outcome === "WIN" ? 1 : 0);
    const nextLosses = member.losses + (input.outcome === "LOSS" ? 1 : 0);
    const nextBalance =
      input.outcome === "WIN" && input.payout > 0
        ? roundMoney(member.virtual_balance + input.payout)
        : member.virtual_balance;

    const { data: updated, error: updateError } = await supabase
      .from("fantasy_game_members")
      .update({
        wins: nextWins,
        losses: nextLosses,
        virtual_balance: nextBalance,
      })
      .eq("id", memberId)
      .eq("wins", member.wins)
      .eq("losses", member.losses)
      .eq("virtual_balance", member.virtual_balance)
      .select("id");

    if (updateError) {
      throw updateError;
    }

    if ((updated?.length ?? 0) > 0) {
      return;
    }
  }

  throw new Error("Fantasy member settlement failed after multiple retries.");
}

export async function listPendingFantasyTradesForGame(
  gameId: string
): Promise<FantasyTrade[]> {
  const { data, error } = await supabase
    .from("fantasy_trades")
    .select("*")
    .eq("game_id", gameId)
    .eq("outcome", "PENDING");

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyTrade(row as FantasyTradeRow));
}

export async function awardFantasyPrize(input: {
  gameId: string;
  memberId: string;
  telegramId: number;
  place: number;
  amount: number;
}): Promise<boolean> {
  const amount = roundMoney(input.amount);

  const { data, error: payoutError } = await supabase
    .from("fantasy_payouts")
    .insert({
      game_id: input.gameId,
      telegram_id: input.telegramId,
      place: input.place,
      amount,
    })
    .select("id");

  if (payoutError) {
    if (isUniqueViolation(payoutError)) {
      return false;
    }

    throw payoutError;
  }

  return (data?.length ?? 0) > 0;
}

export async function revokeFantasyPrize(input: {
  gameId: string;
  telegramId: number;
}): Promise<boolean> {
  const { data, error } = await supabase
    .from("fantasy_payouts")
    .delete()
    .eq("game_id", input.gameId)
    .eq("telegram_id", input.telegramId)
    .select("id");

  if (error) {
    throw error;
  }

  return (data?.length ?? 0) > 0;
}

export async function syncFantasyPrizeAwards(gameId: string): Promise<void> {
  const [members, payouts] = await Promise.all([
    listFantasyGameMembers(gameId),
    listFantasyPayouts(gameId),
  ]);

  const totalsByTelegramId = payouts.reduce((map, payout) => {
    map.set(
      payout.telegram_id,
      roundMoney((map.get(payout.telegram_id) ?? 0) + payout.amount)
    );
    return map;
  }, new Map<number, number>());

  for (const member of members) {
    const nextPrizeAwarded = totalsByTelegramId.get(member.telegram_id) ?? 0;

    if (roundMoney(member.prize_awarded) === nextPrizeAwarded) {
      continue;
    }

    const { error } = await supabase
      .from("fantasy_game_members")
      .update({ prize_awarded: nextPrizeAwarded })
      .eq("id", member.id);

    if (error) {
      throw error;
    }
  }
}

export async function listFantasyPayouts(
  gameId: string
): Promise<Array<{ telegram_id: number; place: number; amount: number }>> {
  const { data, error } = await supabase
    .from("fantasy_payouts")
    .select("telegram_id, place, amount")
    .eq("game_id", gameId)
    .order("place", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => {
    const payout = row as {
      telegram_id: number;
      place: number;
      amount: number | string | null;
    };

    return {
      telegram_id: payout.telegram_id,
      place: payout.place,
      amount: parseMoney(payout.amount),
    };
  });
}

export async function getFantasyLeaderboard(
  gameId: string
): Promise<FantasyLeaderboardEntry[]> {
  const members = await listFantasyGameMembers(gameId);

  const sorted = [...members].sort((left, right) => {
    if (right.virtual_balance !== left.virtual_balance) {
      return right.virtual_balance - left.virtual_balance;
    }

    const leftSettled = left.wins + left.losses;
    const rightSettled = right.wins + right.losses;
    const leftAccuracy = leftSettled > 0 ? left.wins / leftSettled : 0;
    const rightAccuracy = rightSettled > 0 ? right.wins / rightSettled : 0;

    if (rightAccuracy !== leftAccuracy) {
      return rightAccuracy - leftAccuracy;
    }

    if (right.wins !== left.wins) {
      return right.wins - left.wins;
    }

    return Date.parse(left.joined_at) - Date.parse(right.joined_at);
  });

  return sorted.map((member, index) => {
    const settledTrades = member.wins + member.losses;
    const accuracyPct =
      settledTrades > 0
        ? roundMoney((member.wins / settledTrades) * 100)
        : 0;

    return {
      place: index + 1,
      telegram_id: member.telegram_id,
      username: member.username ?? null,
      virtual_balance: member.virtual_balance,
      wins: member.wins,
      losses: member.losses,
      total_trades: member.total_trades,
      accuracy_pct: accuracyPct,
      prize_awarded: member.prize_awarded,
      joined_at: member.joined_at,
    };
  });
}
