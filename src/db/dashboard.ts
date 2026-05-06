import { supabase } from "./client.ts";

const PAGE_SIZE = 1_000;
const MIN_DASHBOARD_DAYS = 7;
const MAX_DASHBOARD_DAYS = 365;

interface UserDashboardRow {
  wallet_balance: number | string | null;
  created_at: string;
  last_seen_at: string;
}

interface DepositDashboardRow {
  amount: number | string | null;
  created_at: string;
}

interface EntryDashboardRow {
  entry_fee_paid: number | string | null;
  joined_at: string;
}

interface RevenueDashboardRow {
  amount: number | string | null;
  created_at: string;
  type: string;
}

interface PayoutDashboardRow {
  amount: number | string | null;
  created_at: string;
}

interface WithdrawalDashboardRow {
  amount: number | string | null;
  completed_at: string | null;
}

interface RecentGameDashboardRow {
  code: string;
  status: "open" | "active" | "completed" | "cancelled";
  entry_fee: number | string | null;
  prize_pool: number | string | null;
  created_at: string;
  start_at: string;
  end_at: string;
}

export interface DashboardSeriesPoint {
  date: string;
  newUsers: number;
  deposits: number;
  entryVolume: number;
  platformRevenue: number;
  completedWithdrawals: number;
}

export interface DashboardSummary {
  generatedAt: string;
  days: number;
  totals: {
    totalUsers: number;
    activeUsers7d: number;
    activeUsers30d: number;
    liveUserBalances: number;
    totalDeposits: number;
    totalEntryVolume: number;
    totalValueProcessed: number;
    totalPlatformRevenue: number;
    totalPrizePayouts: number;
    totalCompletedWithdrawals: number;
  };
  range: {
    newUsers: number;
    deposits: number;
    entryVolume: number;
    valueProcessed: number;
    platformRevenue: number;
    completedWithdrawals: number;
  };
  operations: {
    openGames: number;
    activeGames: number;
    completedGames: number;
    withdrawalsInFlight: number;
  };
  series: DashboardSeriesPoint[];
  recentGames: Array<{
    code: string;
    status: "open" | "active" | "completed" | "cancelled";
    entryFee: number;
    prizePool: number;
    createdAt: string;
    startAt: string;
    endAt: string;
  }>;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseMoney(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundMoney(value) : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
  }

  return 0;
}

function clampDashboardDays(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 30;
  }

  return Math.min(
    MAX_DASHBOARD_DAYS,
    Math.max(MIN_DASHBOARD_DAYS, Math.round(value))
  );
}

function startOfUtcDay(input: Date): Date {
  return new Date(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate())
  );
}

function addUtcDays(input: Date, days: number): Date {
  const next = new Date(input);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDayKey(input: Date | string): string {
  return (typeof input === "string" ? input : input.toISOString()).slice(0, 10);
}

function sumValues<T>(rows: T[], selector: (row: T) => number): number {
  return roundMoney(rows.reduce((total, row) => total + selector(row), 0));
}

function countSince(
  timestamps: Array<string | null | undefined>,
  sinceMs: number
): number {
  return timestamps.reduce((count, value) => {
    if (!value) {
      return count;
    }

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= sinceMs ? count + 1 : count;
  }, 0);
}

async function fetchAllRows<T>(buildQuery: () => any): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const batch = (data ?? []) as T[];

    if (batch.length === 0) {
      break;
    }

    rows.push(...batch);

    if (batch.length < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return rows;
}

function buildEmptySeries(days: number): DashboardSeriesPoint[] {
  const today = startOfUtcDay(new Date());
  const start = addUtcDays(today, -(days - 1));

  return Array.from({ length: days }, (_, index) => {
    const pointDate = addUtcDays(start, index);
    return {
      date: toDayKey(pointDate),
      newUsers: 0,
      deposits: 0,
      entryVolume: 0,
      platformRevenue: 0,
      completedWithdrawals: 0,
    };
  });
}

function buildSeriesIndex(
  series: DashboardSeriesPoint[]
): Map<string, DashboardSeriesPoint> {
  return series.reduce((map, point) => {
    map.set(point.date, point);
    return map;
  }, new Map<string, DashboardSeriesPoint>());
}

function safeIncrement(
  index: Map<string, DashboardSeriesPoint>,
  isoDate: string | null | undefined,
  field: keyof Omit<DashboardSeriesPoint, "date">,
  amount: number
): void {
  if (!isoDate) {
    return;
  }

  const point = index.get(toDayKey(isoDate));

  if (!point) {
    return;
  }

  point[field] = roundMoney(point[field] + amount);
}

function normalizeRecentGame(row: RecentGameDashboardRow) {
  return {
    code: row.code,
    status: row.status,
    entryFee: parseMoney(row.entry_fee),
    prizePool: parseMoney(row.prize_pool),
    createdAt: row.created_at,
    startAt: row.start_at,
    endAt: row.end_at,
  };
}

export async function getDashboardSummary(
  requestedDays?: number
): Promise<DashboardSummary> {
  const days = clampDashboardDays(requestedDays);
  const series = buildEmptySeries(days);
  const seriesIndex = buildSeriesIndex(series);
  const seriesStartMs = Date.parse(`${series[0]?.date ?? toDayKey(new Date())}T00:00:00.000Z`);
  const active7SinceMs = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  const active30SinceMs = Date.now() - 30 * 24 * 60 * 60 * 1_000;

  const [
    userRows,
    depositRows,
    entryRows,
    revenueRows,
    payoutRows,
    completedWithdrawalRows,
    openGamesResult,
    activeGamesResult,
    completedGamesResult,
    withdrawalsInFlightResult,
    recentGamesResult,
  ] = await Promise.all([
    fetchAllRows<UserDashboardRow>(() =>
      supabase
        .from("fantasy_users")
        .select("wallet_balance, created_at, last_seen_at")
        .order("created_at", { ascending: true })
    ),
    fetchAllRows<DepositDashboardRow>(() =>
      supabase
        .from("fantasy_wallet_deposits")
        .select("amount, created_at")
        .order("created_at", { ascending: true })
    ),
    fetchAllRows<EntryDashboardRow>(() =>
      supabase
        .from("fantasy_game_members")
        .select("entry_fee_paid, joined_at")
        .order("joined_at", { ascending: true })
    ),
    fetchAllRows<RevenueDashboardRow>(() =>
      supabase
        .from("fantasy_revenue")
        .select("amount, created_at, type")
        .order("created_at", { ascending: true })
    ),
    fetchAllRows<PayoutDashboardRow>(() =>
      supabase
        .from("fantasy_payouts")
        .select("amount, created_at")
        .order("created_at", { ascending: true })
    ),
    fetchAllRows<WithdrawalDashboardRow>(() =>
      supabase
        .from("fantasy_wallet_withdrawals")
        .select("amount, completed_at")
        .eq("status", "completed")
        .order("completed_at", { ascending: true })
    ),
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }).eq("status", "active"),
    supabase
      .from("fantasy_games")
      .select("*", { count: "exact", head: true })
      .eq("status", "completed"),
    supabase
      .from("fantasy_wallet_withdrawals")
      .select("*", { count: "exact", head: true })
      .in("status", ["pending", "processing"]),
    supabase
      .from("fantasy_games")
      .select("code, status, entry_fee, prize_pool, created_at, start_at, end_at")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  if (openGamesResult.error) {
    throw openGamesResult.error;
  }

  if (activeGamesResult.error) {
    throw activeGamesResult.error;
  }

  if (completedGamesResult.error) {
    throw completedGamesResult.error;
  }

  if (withdrawalsInFlightResult.error) {
    throw withdrawalsInFlightResult.error;
  }

  if (recentGamesResult.error) {
    throw recentGamesResult.error;
  }

  const totalUsers = userRows.length;
  const activeUsers7d = countSince(
    userRows.map((row) => row.last_seen_at),
    active7SinceMs
  );
  const activeUsers30d = countSince(
    userRows.map((row) => row.last_seen_at),
    active30SinceMs
  );
  const liveUserBalances = sumValues(userRows, (row) =>
    parseMoney(row.wallet_balance)
  );
  const totalDeposits = sumValues(depositRows, (row) => parseMoney(row.amount));
  const totalEntryVolume = sumValues(entryRows, (row) =>
    parseMoney(row.entry_fee_paid)
  );
  const totalPlatformRevenue = sumValues(revenueRows, (row) =>
    parseMoney(row.amount)
  );
  const totalPrizePayouts = sumValues(payoutRows, (row) =>
    parseMoney(row.amount)
  );
  const totalCompletedWithdrawals = sumValues(
    completedWithdrawalRows,
    (row) => parseMoney(row.amount)
  );

  for (const row of userRows) {
    const createdAtMs = Date.parse(row.created_at);

    if (Number.isFinite(createdAtMs) && createdAtMs >= seriesStartMs) {
      safeIncrement(seriesIndex, row.created_at, "newUsers", 1);
    }
  }

  for (const row of depositRows) {
    safeIncrement(seriesIndex, row.created_at, "deposits", parseMoney(row.amount));
  }

  for (const row of entryRows) {
    safeIncrement(
      seriesIndex,
      row.joined_at,
      "entryVolume",
      parseMoney(row.entry_fee_paid)
    );
  }

  for (const row of revenueRows) {
    safeIncrement(
      seriesIndex,
      row.created_at,
      "platformRevenue",
      parseMoney(row.amount)
    );
  }

  for (const row of completedWithdrawalRows) {
    safeIncrement(
      seriesIndex,
      row.completed_at,
      "completedWithdrawals",
      parseMoney(row.amount)
    );
  }

  const range = {
    newUsers: series.reduce((total, point) => total + point.newUsers, 0),
    deposits: roundMoney(
      series.reduce((total, point) => total + point.deposits, 0)
    ),
    entryVolume: roundMoney(
      series.reduce((total, point) => total + point.entryVolume, 0)
    ),
    valueProcessed: roundMoney(
      series.reduce((total, point) => total + point.entryVolume, 0)
    ),
    platformRevenue: roundMoney(
      series.reduce((total, point) => total + point.platformRevenue, 0)
    ),
    completedWithdrawals: roundMoney(
      series.reduce((total, point) => total + point.completedWithdrawals, 0)
    ),
  };

  return {
    generatedAt: new Date().toISOString(),
    days,
    totals: {
      totalUsers,
      activeUsers7d,
      activeUsers30d,
      liveUserBalances,
      totalDeposits,
      totalEntryVolume,
      totalValueProcessed: totalEntryVolume,
      totalPlatformRevenue,
      totalPrizePayouts,
      totalCompletedWithdrawals,
    },
    range,
    operations: {
      openGames: openGamesResult.count ?? 0,
      activeGames: activeGamesResult.count ?? 0,
      completedGames: completedGamesResult.count ?? 0,
      withdrawalsInFlight: withdrawalsInFlightResult.count ?? 0,
    },
    series,
    recentGames: ((recentGamesResult.data ?? []) as RecentGameDashboardRow[]).map(
      normalizeRecentGame
    ),
  };
}

export { clampDashboardDays };
