import { supabase } from "../src/db/client.ts";

const DEMO_CREATOR_TELEGRAM_ID = 7_068_951_342;
const DEMO_ENTRY_FEE = 10;
const DEMO_DURATION_HOURS = 24;
const DEMO_PRIZE_POOL = 138;
const DEMO_COMMISSION_AMOUNT = 12;
const DEMO_MAX_PLAYERS = 15;
const DEMO_STARTING_BALANCE = 1000;
const DEMO_MEMBER_TABLE_CANDIDATES = ["fantasy_members", "fantasy_game_members"] as const;
const DEMO_GAME_STATUS_CANDIDATES = ["live", "active"] as const;
const DEMO_DIRECTION_CANDIDATES = [
  ["YES", "NO"],
  ["UP", "DOWN"],
] as const;
const DEMO_OUTCOME_CANDIDATES = [
  ["win", "loss"],
  ["WIN", "LOSS"],
] as const;
const DEMO_USERNAMES = [
  "Xage",
  "CallMi_Alex",
  "distinct_10",
  "Abiodun",
  "faith_jul",
  "crypto_kay99",
  "traderboi_ng",
  "boyboye",
  "Roland_ayd",
  "web3_wale",
  "Darboiz_",
  "bullrun_eze",
  "Adiking",
  "0xTunde",
  "leomaxi",
] as const;
const DEMO_BALANCES = [
  1847,
  1623,
  1589,
  1412,
  1388,
  1274,
  1201,
  1089,
  987,
  921,
  834,
  712,
  634,
  521,
  398,
] as const;

type TradePlan = {
  createdAt: string;
  resolvedAt: string;
  eventId: string;
  marketId: string;
  directionIsYes: boolean;
  outcomeIsWin: boolean;
  stake: number;
  entryPrice: number;
  shares: number;
  payout: number;
};

type MemberPlan = {
  telegramId: number;
  username: string;
  virtualBalance: number;
  rank: number;
  joinedAt: string;
  tradePlans: TradePlan[];
  wins: number;
  losses: number;
  totalTrades: number;
  lastTradedRound: number | null;
};

type ColumnMap = {
  memberTable: string;
};

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomNumber(min: number, max: number, decimals = 2): number {
  const factor = 10 ** decimals;
  const value = min + Math.random() * (max - min);
  return Math.round(value * factor) / factor;
}

function pickRandomUnique(poolValues: number[], count: number): number[] {
  const pool = [...poolValues];
  const picked: number[] = [];

  while (picked.length < count && pool.length > 0) {
    const index = randomInt(0, pool.length - 1);
    picked.push(pool[index]!);
    pool.splice(index, 1);
  }

  return picked.sort((left, right) => left - right);
}

function shortCode(): string {
  const left = Math.random().toString(36).slice(2, 5).toUpperCase();
  const right = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${left}-${right}`;
}

function buildDemoMemberPlans(startAt: Date): MemberPlan[] {
  const allRounds = Array.from({ length: 24 }, (_, index) => index + 1);

  return DEMO_USERNAMES.map((username, index) => {
    const rank = index + 1;
    const virtualBalance = DEMO_BALANCES[index]!;
    const telegramId = DEMO_CREATOR_TELEGRAM_ID + index;
    const joinedAt = new Date(startAt.getTime() - randomInt(5, 35) * 60_000).toISOString();
    const tradeCount = randomInt(8, 12);
    const selectedRounds = pickRandomUnique(allRounds, tradeCount);

    let winsTarget: number;

    if (virtualBalance > DEMO_STARTING_BALANCE) {
      winsTarget = randomInt(
        Math.max(5, Math.ceil(tradeCount * 0.58)),
        Math.max(5, tradeCount - 2)
      );
    } else {
      winsTarget = randomInt(
        Math.max(1, Math.floor(tradeCount * 0.15)),
        Math.max(1, Math.floor(tradeCount * 0.42))
      );
    }

    winsTarget = Math.min(Math.max(winsTarget, 0), tradeCount);
    const winningRounds = new Set(pickRandomUnique(selectedRounds, winsTarget));
    const directionStartsWithYes = Math.random() >= 0.5;

    const tradePlans = selectedRounds.map((roundNumber, tradeIndex) => {
      const roundStart = new Date(
        startAt.getTime() + (roundNumber - 1) * 15 * 60_000
      );
      const createdAtDate = new Date(
        roundStart.getTime() + randomInt(2, 11) * 60_000
      );
      const resolvedAtDate = new Date(
        createdAtDate.getTime() + randomInt(3, 12) * 60_000
      );
      const stake = randomInt(50, 200);
      const entryPrice = randomNumber(0.38, 0.69, 4);
      const shares = Number((stake / entryPrice).toFixed(6));
      const outcomeIsWin = winningRounds.has(roundNumber);
      const payout = outcomeIsWin
        ? roundMoney(stake * randomNumber(1.45, 2.2, 2))
        : 0;
      const directionIsYes = directionStartsWithYes
        ? tradeIndex % 2 === 0
        : tradeIndex % 2 === 1;

      return {
        createdAt: createdAtDate.toISOString(),
        resolvedAt: resolvedAtDate.toISOString(),
        eventId: `DEMO-R${String(roundNumber).padStart(2, "0")}`,
        marketId: `BTC-15M-R${String(roundNumber).padStart(2, "0")}`,
        directionIsYes,
        outcomeIsWin,
        stake,
        entryPrice,
        shares,
        payout,
      };
    });

    const wins = tradePlans.filter((trade) => trade.outcomeIsWin).length;
    const losses = tradePlans.length - wins;

    return {
      telegramId,
      username,
      virtualBalance,
      rank,
      joinedAt,
      tradePlans,
      wins,
      losses,
      totalTrades: tradePlans.length,
      lastTradedRound: selectedRounds.at(-1) ?? null,
    };
  });
}

function isMissingTableError(error: unknown, table: string): boolean {
  const candidate = error as { code?: string; message?: string } | null;

  if (!candidate) {
    return false;
  }

  return (
    candidate.code === "42P01" ||
    candidate.code === "PGRST205" ||
    (typeof candidate.message === "string" &&
      candidate.message.toLowerCase().includes(table.toLowerCase()) &&
      candidate.message.toLowerCase().includes("not found"))
  );
}

function isConstraintValueError(error: unknown, column: string): boolean {
  const candidate = error as { code?: string; message?: string; details?: string } | null;
  const text = `${candidate?.message ?? ""} ${candidate?.details ?? ""}`.toLowerCase();
  return candidate?.code === "23514" || text.includes(column.toLowerCase());
}

function extractMissingColumnName(error: unknown): string | null {
  const candidate = error as { message?: string } | null;

  if (!candidate?.message) {
    return null;
  }

  const postgresStyleMatch = candidate.message.match(
    /column\s+(?:[a-zA-Z_][\w]*\.)?("?)([a-zA-Z_][\w]*)\1\s+does not exist/i
  );

  if (postgresStyleMatch?.[2]) {
    return postgresStyleMatch[2];
  }

  const schemaCacheMatch = candidate.message.match(
    /could not find the '([a-zA-Z_][\w]*)' column of '[a-zA-Z_][\w]*' in the schema cache/i
  );

  return schemaCacheMatch?.[1] ?? null;
}

function cloneRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

function stripColumnFromRows(
  rows: Array<Record<string, unknown>>,
  column: string,
  protectedColumns: readonly string[]
): boolean {
  if (protectedColumns.includes(column)) {
    return false;
  }

  let removed = false;

  for (const row of rows) {
    if (column in row) {
      delete row[column];
      removed = true;
    }
  }

  return removed;
}

async function findFirstExistingTable(candidates: readonly string[]): Promise<string> {
  for (const table of candidates) {
    const { error } = await supabase.from(table).select("id").limit(1);

    if (!error) {
      return table;
    }

    if (!isMissingTableError(error, table)) {
      throw error;
    }
  }

  throw new Error(
    `None of the expected tables exist: ${candidates.join(", ")}`
  );
}

async function insertRowsWithUnknownColumnFallback<T>(
  table: string,
  rows: Array<Record<string, unknown>>,
  options?: {
    protectedColumns?: readonly string[];
    select?: string;
    single?: boolean;
  }
): Promise<T> {
  const workingRows = cloneRows(rows);
  const protectedColumns = options?.protectedColumns ?? [];

  for (let attempt = 0; attempt < 25; attempt += 1) {
    let query = supabase.from(table).insert(workingRows);

    if (options?.select) {
      query = query.select(options.select);
    }

    const result = options?.single ? await query.single() : await query;

    if (!result.error) {
      return result.data as T;
    }

    const missingColumn = extractMissingColumnName(result.error);

    if (
      missingColumn &&
      stripColumnFromRows(workingRows, missingColumn, protectedColumns)
    ) {
      continue;
    }

    throw result.error;
  }

  throw new Error(`Unable to insert rows into ${table} after stripping unknown columns.`);
}

async function generateUniqueGameCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = shortCode();
    const { data, error } = await supabase
      .from("fantasy_games")
      .select("id")
      .eq("code", code)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return code;
    }
  }

  throw new Error("Unable to generate a unique demo arena code.");
}

async function resolveColumnMap(): Promise<ColumnMap> {
  return {
    memberTable: await findFirstExistingTable(DEMO_MEMBER_TABLE_CANDIDATES),
  };
}

async function upsertDemoUsers(memberPlans: MemberPlan[]): Promise<void> {
  const now = new Date().toISOString();
  const payload = memberPlans.map((memberPlan) => ({
    telegram_id: memberPlan.telegramId,
    username: memberPlan.username,
    wallet_balance: 0,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  }));

  const { error } = await supabase
    .from("fantasy_users")
    .upsert(payload, { onConflict: "telegram_id" });

  if (error) {
    throw error;
  }
}

async function insertGameRow(
  code: string,
  _columns: ColumnMap,
  startAtIso: string,
  endAtIso: string
): Promise<{ id: string; code: string }> {
  const basePayload: Record<string, unknown> = {
    code,
    entry_fee: DEMO_ENTRY_FEE,
    start_at: startAtIso,
    end_at: endAtIso,
    prize_pool: DEMO_PRIZE_POOL,
    creator_id: DEMO_CREATOR_TELEGRAM_ID,
    creator_telegram_id: DEMO_CREATOR_TELEGRAM_ID,
    virtual_start_balance: DEMO_STARTING_BALANCE,
    asset: "BTC",
    duration_hours: DEMO_DURATION_HOURS,
    commission: DEMO_COMMISSION_AMOUNT,
    commission_amount: DEMO_COMMISSION_AMOUNT,
    commission_rate: 0.08,
    max_players: DEMO_MAX_PLAYERS,
  };

  for (const status of DEMO_GAME_STATUS_CANDIDATES) {
    try {
      return await insertRowsWithUnknownColumnFallback<{ id: string; code: string }>(
        "fantasy_games",
        [{ ...basePayload, status }],
        {
          select: "id, code",
          single: true,
        }
      );
    } catch (error) {
      if (isConstraintValueError(error, "status")) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Unable to insert demo game because none of the status values were accepted: ${DEMO_GAME_STATUS_CANDIDATES.join(", ")}`
  );
}

async function insertMemberRows(
  gameId: string,
  columns: ColumnMap,
  memberPlans: MemberPlan[]
): Promise<Map<number, string>> {
  const payload = memberPlans.map((memberPlan) => ({
    game_id: gameId,
    telegram_id: memberPlan.telegramId,
    user_id: memberPlan.telegramId,
    telegram_username: memberPlan.username,
    username: memberPlan.username,
    entry_fee_paid: DEMO_ENTRY_FEE,
    virtual_balance: memberPlan.virtualBalance,
    starting_balance: DEMO_STARTING_BALANCE,
    status: "active",
    rank: memberPlan.rank,
    joined_at: memberPlan.joinedAt,
    total_trades: memberPlan.totalTrades,
    wins: memberPlan.wins,
    losses: memberPlan.losses,
    last_traded_round: memberPlan.lastTradedRound,
    consecutive_missed_rounds: 0,
    prize_awarded: 0,
  }));

  const data = await insertRowsWithUnknownColumnFallback<Array<Record<string, unknown>>>(
    columns.memberTable,
    payload,
    {
      select: "*",
    }
  );

  const memberIdsByTelegramId = new Map<number, string>();

  for (const row of data ?? []) {
    const telegramId = Number(row.telegram_id ?? row.user_id);
    const memberId = typeof row.id === "string" ? row.id : String(row.id ?? "");

    if (Number.isFinite(telegramId) && memberId) {
      memberIdsByTelegramId.set(telegramId, memberId);
    }
  }

  if (memberIdsByTelegramId.size !== memberPlans.length) {
    throw new Error(
      `Expected ${memberPlans.length} inserted members, received ${memberIdsByTelegramId.size}.`
    );
  }

  return memberIdsByTelegramId;
}

async function insertTradeRows(
  gameId: string,
  _columns: ColumnMap,
  memberPlans: MemberPlan[],
  memberIdsByTelegramId: Map<number, string>
): Promise<number> {
  const tradeBlueprints = memberPlans.flatMap((memberPlan) => {
    const memberId = memberIdsByTelegramId.get(memberPlan.telegramId);

    if (!memberId) {
      throw new Error(`Missing inserted member ID for ${memberPlan.telegramId}.`);
    }

    return memberPlan.tradePlans.map((tradePlan, tradeIndex) => ({
      memberPlan,
      memberId,
      tradePlan,
      tradeIndex,
    }));
  });

  for (const [yesDirection, noDirection] of DEMO_DIRECTION_CANDIDATES) {
    for (const [winOutcome, lossOutcome] of DEMO_OUTCOME_CANDIDATES) {
      const payload = tradeBlueprints.map(
        ({ memberPlan, memberId, tradePlan, tradeIndex }) => ({
          game_id: gameId,
          member_id: memberId,
          fantasy_member_id: memberId,
          telegram_id: memberPlan.telegramId,
          event_id: `${tradePlan.eventId}-P${String(memberPlan.rank).padStart(2, "0")}-T${String(
            tradeIndex + 1
          ).padStart(2, "0")}`,
          market_id: tradePlan.marketId,
          direction: tradePlan.directionIsYes ? yesDirection : noDirection,
          stake: tradePlan.stake,
          entry_price: tradePlan.entryPrice,
          shares: tradePlan.shares,
          outcome: tradePlan.outcomeIsWin ? winOutcome : lossOutcome,
          payout: tradePlan.payout,
          created_at: tradePlan.createdAt,
          resolved_at: tradePlan.resolvedAt,
        })
      );

      try {
        await insertRowsWithUnknownColumnFallback<null>("fantasy_trades", payload);
        return payload.length;
      } catch (error) {
        if (
          isConstraintValueError(error, "direction") ||
          isConstraintValueError(error, "outcome")
        ) {
          continue;
        }

        throw error;
      }
    }
  }

  throw new Error(
    "Unable to insert demo trades because none of the expected direction/outcome mappings were accepted."
  );
}

async function cleanupGame(gameId: string): Promise<void> {
  const { error } = await supabase.from("fantasy_games").delete().eq("id", gameId);

  if (error) {
    console.error(
      `[seed-demo-arena] Failed to clean up partial game ${gameId}:`,
      error
    );
  }
}

async function main(): Promise<void> {
  const columns = await resolveColumnMap();
  const code = await generateUniqueGameCode();
  const now = new Date();
  const startAt = new Date(now.getTime() - 6 * 60 * 60_000);
  const endAt = new Date(now.getTime() + 18 * 60 * 60_000);
  const memberPlans = buildDemoMemberPlans(startAt);

  await upsertDemoUsers(memberPlans);

  let insertedGameId: string | null = null;

  try {
    const game = await insertGameRow(
      code,
      columns,
      startAt.toISOString(),
      endAt.toISOString()
    );
    insertedGameId = game.id;

    const memberIdsByTelegramId = await insertMemberRows(
      game.id,
      columns,
      memberPlans
    );
    const insertedTrades = await insertTradeRows(
      game.id,
      columns,
      memberPlans,
      memberIdsByTelegramId
    );

    console.log(`Seeded demo arena ${game.code}`);
    console.log(`Members: ${memberPlans.length}`);
    console.log(`Trades: ${insertedTrades}`);
    console.log(`Use with: /board ${game.code}`);
  } catch (error) {
    if (insertedGameId) {
      await cleanupGame(insertedGameId);
    }

    throw error;
  }
}

main().catch((error) => {
  console.error("[seed-demo-arena] Failed to seed demo arena.");
  console.error(error);
  process.exit(1);
});
