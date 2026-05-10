import { supabase } from "./supabase";

const PAGE_SIZE = 1_000;

function roundMoney(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function parseMoney(v: number | string | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? roundMoney(v) : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? roundMoney(n) : 0;
  }
  return 0;
}

async function fetchAll<T>(build: () => any): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await build().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

export interface DashboardData {
  generatedAt: string;
  // users
  totalUsers: number;
  fundedUsers: number;
  activeUsers7d: number;
  activeUsers30d: number;
  liveUserBalances: number;
  // arenas
  totalArenas: number;
  openArenas: number;
  activeArenas: number;
  completedArenas: number;
  arenaPlayers: number;
  // money
  totalDeposits: number;
  totalPrizePayouts: number;
  platformRevenue: number;
  totalCompletedWithdrawals: number;
  withdrawalsInFlight: number;
  // recent arenas
  recentArenas: Array<{
    code: string;
    status: string;
    entryFee: number;
    prizePool: number;
    createdAt: string;
    startAt: string;
    endAt: string;
  }>;
}

export async function getDashboardData(): Promise<DashboardData> {
  const now = Date.now();
  const active7Ms = now - 7 * 86_400_000;
  const active30Ms = now - 30 * 86_400_000;

  const [
    userRows,
    depositRows,
    revenueRows,
    payoutRows,
    withdrawalRows,
    openRes,
    activeRes,
    completedRes,
    totalArenasRes,
    arenaPlayersRes,
    inFlightRes,
    recentRes,
  ] = await Promise.all([
    fetchAll<{ wallet_balance: number | string | null; created_at: string; last_seen_at: string }>(
      () => supabase.from("fantasy_users").select("wallet_balance, created_at, last_seen_at")
    ),
    fetchAll<{ amount: number | string | null }>(
      () => supabase.from("fantasy_wallet_deposits").select("amount")
    ),
    fetchAll<{ amount: number | string | null }>(
      () => supabase.from("fantasy_revenue").select("amount")
    ),
    fetchAll<{ amount: number | string | null }>(
      () => supabase.from("fantasy_payouts").select("amount")
    ),
    fetchAll<{ amount: number | string | null }>(
      () =>
        supabase
          .from("fantasy_wallet_withdrawals")
          .select("amount")
          .eq("status", "completed")
    ),
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }).eq("status", "completed"),
    supabase.from("fantasy_games").select("*", { count: "exact", head: true }),
    supabase.from("fantasy_game_members").select("*", { count: "exact", head: true }),
    supabase
      .from("fantasy_wallet_withdrawals")
      .select("*", { count: "exact", head: true })
      .in("status", ["pending", "processing"]),
    supabase
      .from("fantasy_games")
      .select("code, status, entry_fee, prize_pool, created_at, start_at, end_at")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  for (const r of [openRes, activeRes, completedRes, totalArenasRes, arenaPlayersRes, inFlightRes, recentRes]) {
    if (r.error) throw r.error;
  }

  const sum = (rows: Array<{ amount: number | string | null }>) =>
    roundMoney(rows.reduce((t, r) => t + parseMoney(r.amount), 0));

  const fundedUsers = userRows.filter((r) => parseMoney(r.wallet_balance) > 0).length;
  const activeUsers7d = userRows.filter(
    (r) => r.last_seen_at && Date.parse(r.last_seen_at) >= active7Ms
  ).length;
  const activeUsers30d = userRows.filter(
    (r) => r.last_seen_at && Date.parse(r.last_seen_at) >= active30Ms
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    totalUsers: userRows.length,
    fundedUsers,
    activeUsers7d,
    activeUsers30d,
    liveUserBalances: roundMoney(userRows.reduce((t, r) => t + parseMoney(r.wallet_balance), 0)),
    totalArenas: totalArenasRes.count ?? 0,
    openArenas: openRes.count ?? 0,
    activeArenas: activeRes.count ?? 0,
    completedArenas: completedRes.count ?? 0,
    arenaPlayers: arenaPlayersRes.count ?? 0,
    totalDeposits: sum(depositRows),
    totalPrizePayouts: sum(payoutRows),
    platformRevenue: sum(revenueRows),
    totalCompletedWithdrawals: sum(withdrawalRows),
    withdrawalsInFlight: inFlightRes.count ?? 0,
    recentArenas: ((recentRes.data ?? []) as any[]).map((r) => ({
      code: r.code,
      status: r.status,
      entryFee: parseMoney(r.entry_fee),
      prizePool: parseMoney(r.prize_pool),
      createdAt: r.created_at,
      startAt: r.start_at,
      endAt: r.end_at,
    })),
  };
}
