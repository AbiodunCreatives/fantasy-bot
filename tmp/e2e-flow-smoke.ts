// Smoke harness for the private-beta fantasy flow.
// It runs against in-memory Supabase and mocked Bayse/Telegram APIs.

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type DbTableName =
  | "fantasy_users"
  | "fantasy_revenue"
  | "fantasy_games"
  | "fantasy_game_members"
  | "fantasy_trades"
  | "fantasy_payouts";

interface DbState {
  fantasy_users: Array<Record<string, unknown>>;
  fantasy_revenue: Array<Record<string, unknown>>;
  fantasy_games: Array<Record<string, unknown>>;
  fantasy_game_members: Array<Record<string, unknown>>;
  fantasy_trades: Array<Record<string, unknown>>;
  fantasy_payouts: Array<Record<string, unknown>>;
}

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

const RealDate = Date;
let nowMs = RealDate.parse("2026-04-12T12:00:00.000Z");

class FakeDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length === 0) {
      super(nowMs);
      return;
    }

    super(...args);
  }

  static now(): number {
    return nowMs;
  }

  static parse(value: string): number {
    return RealDate.parse(value);
  }

  static UTC(...args: Parameters<typeof Date.UTC>): number {
    return RealDate.UTC(...args);
  }
}

globalThis.Date = FakeDate as typeof Date;

process.env.BOT_TOKEN = "123:TEST";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.REDIS_MODE = "memory";
process.env.VIRTUAL_WALLET_START_BALANCE = "40";
process.env.NODE_ENV = "test";

const eventStore: Record<string, Record<string, unknown>> = {
  evt0: {
    id: "evt0",
    slug: "crypto-btc-15min-1150",
    status: "open",
    openingDate: "2026-04-12T11:50:00.000Z",
    closingDate: "2026-04-12T12:05:00.000Z",
    eventThreshold: 90000,
    seriesSlug: "crypto-btc-15min",
    markets: [
      {
        id: "mkt0",
        outcome1Id: "yes0",
        outcome2Id: "no0",
        outcome1Price: 0.52,
        outcome2Price: 0.48,
        status: "open",
      },
    ],
  },
  evt1: {
    id: "evt1",
    slug: "crypto-btc-15min-1205",
    status: "open",
    openingDate: "2026-04-12T12:05:00.000Z",
    closingDate: "2026-04-12T12:20:00.000Z",
    eventThreshold: 90100,
    seriesSlug: "crypto-btc-15min",
    markets: [
      {
        id: "mkt1",
        outcome1Id: "yes1",
        outcome2Id: "no1",
        outcome1Price: 0.55,
        outcome2Price: 0.45,
        status: "open",
      },
    ],
  },
  evt2: {
    id: "evt2",
    slug: "crypto-btc-15min-1220",
    status: "open",
    openingDate: "2026-04-12T12:20:00.000Z",
    closingDate: "2026-04-12T12:35:00.000Z",
    eventThreshold: 90200,
    seriesSlug: "crypto-btc-15min",
    markets: [
      {
        id: "mkt2",
        outcome1Id: "yes2",
        outcome2Id: "no2",
        outcome1Price: 0.51,
        outcome2Price: 0.49,
        status: "open",
      },
    ],
  },
};

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));

  if (url.pathname === "/v1/pm/events") {
    return {
      ok: true,
      status: 200,
      json: async () => ({ events: Object.values(eventStore).map(clone) }),
      text: async () => "",
    } as Response;
  }

  const quoteMatch = url.pathname.match(
    /^\/v1\/pm\/events\/([^/]+)\/markets\/([^/]+)\/quote$/
  );

  if (quoteMatch) {
    const eventId = quoteMatch[1] ?? "";
    const marketId = quoteMatch[2] ?? "";
    const event = eventStore[eventId];
    const market = (event?.markets as Array<Record<string, unknown>> | undefined)?.find(
      (candidate) => candidate.id === marketId
    );

    if (!event || !market) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "Not found",
      } as Response;
    }

    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    const amount = Number(payload.amount ?? 0);
    const outcomeId = String(payload.outcomeId ?? "");
    const price =
      outcomeId === market.outcome1Id
        ? Number(market.outcome1Price ?? 0)
        : Number(market.outcome2Price ?? 0);
    const quantity = price > 0 ? amount / price : 0;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        price,
        currentMarketPrice: price,
        quantity,
        amount,
        costOfShares: amount,
        fee: 0,
        priceImpactAbsolute: 0,
        profitPercentage: null,
        currencyBaseMultiplier: 1,
        completeFill: true,
        tradeGoesOverMaxLiability: false,
      }),
      text: async () => "",
    } as Response;
  }

  const eventMatch = url.pathname.match(/^\/v1\/pm\/events\/([^/]+)$/);

  if (eventMatch) {
    const event = eventStore[eventMatch[1] ?? ""];

    if (!event) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "Not found",
      } as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => clone(event),
      text: async () => "",
    } as Response;
  }

  throw new Error(`Unexpected fetch URL: ${url.toString()}`);
};

function makeError(message: string, code?: string): { message: string; code?: string } {
  return { message, code };
}

function rowMatches(row: Record<string, unknown>, filters: Array<(row: Record<string, unknown>) => boolean>): boolean {
  return filters.every((filter) => filter(row));
}

function projectRows(
  db: DbState,
  table: DbTableName,
  rows: Array<Record<string, unknown>>,
  selection: string
): Array<Record<string, unknown>> {
  if (!selection || selection === "*") {
    return rows.map(clone);
  }

  if (table === "fantasy_game_members" && selection === "fantasy_games(*)") {
    return rows.map((row) => ({
      fantasy_games: clone(
        db.fantasy_games.find((game) => game.id === row.game_id) ?? null
      ),
    }));
  }

  const columns = selection.split(",").map((column) => column.trim());

  return rows.map((row) => {
    const projected: Record<string, unknown> = {};

    for (const column of columns) {
      projected[column] = row[column];
    }

    return clone(projected);
  });
}

function createInsertedRow(
  counters: Record<DbTableName, number>,
  table: DbTableName,
  row: Record<string, unknown>
): Record<string, unknown> {
  const next = clone(row);
  const nowIso = new Date().toISOString();

  if (table === "fantasy_users") {
    next.created_at = next.created_at ?? nowIso;
    next.updated_at = next.updated_at ?? nowIso;
    next.last_seen_at = next.last_seen_at ?? nowIso;
    return next;
  }

  if (table === "fantasy_revenue") {
    next.id = next.id ?? `revenue_${counters.fantasy_revenue++}`;
    next.created_at = next.created_at ?? nowIso;
    return next;
  }

  if (table === "fantasy_games") {
    next.id = next.id ?? `game_${counters.fantasy_games++}`;
    next.asset = next.asset ?? "BTC";
    next.status = next.status ?? "open";
    next.prize_pool = next.prize_pool ?? 0;
    next.last_round_event_id = next.last_round_event_id ?? null;
    next.created_at = next.created_at ?? nowIso;
    next.completed_at = next.completed_at ?? null;
    next.cancelled_at = next.cancelled_at ?? null;
    return next;
  }

  if (table === "fantasy_game_members") {
    next.id = next.id ?? `member_${counters.fantasy_game_members++}`;
    next.joined_at = next.joined_at ?? nowIso;
    next.total_trades = next.total_trades ?? 0;
    next.wins = next.wins ?? 0;
    next.losses = next.losses ?? 0;
    next.prize_awarded = next.prize_awarded ?? 0;
    return next;
  }

  if (table === "fantasy_trades") {
    next.id = next.id ?? `trade_${counters.fantasy_trades++}`;
    next.created_at = next.created_at ?? nowIso;
    next.resolved_at = next.resolved_at ?? null;
    return next;
  }

  next.id = next.id ?? `payout_${counters.fantasy_payouts++}`;
  next.created_at = next.created_at ?? nowIso;
  return next;
}

function findUniqueInsertError(
  db: DbState,
  table: DbTableName,
  row: Record<string, unknown>
): { message: string; code?: string } | null {
  if (
    table === "fantasy_users" &&
    db.fantasy_users.some((entry) => entry.telegram_id === row.telegram_id)
  ) {
    return makeError("duplicate key value violates unique constraint", "23505");
  }

  if (
    table === "fantasy_revenue" &&
    db.fantasy_revenue.some((entry) => entry.type === row.type)
  ) {
    return makeError("duplicate key value violates unique constraint", "23505");
  }

  if (
    table === "fantasy_games" &&
    db.fantasy_games.some((entry) => entry.code === row.code)
  ) {
    return makeError("duplicate key value violates unique constraint", "23505");
  }

  if (
    table === "fantasy_game_members" &&
    db.fantasy_game_members.some(
      (entry) =>
        entry.game_id === row.game_id && entry.telegram_id === row.telegram_id
    )
  ) {
    return makeError("duplicate key value violates unique constraint", "23505");
  }

  if (
    table === "fantasy_trades" &&
    db.fantasy_trades.some(
      (entry) =>
        entry.game_id === row.game_id &&
        entry.member_id === row.member_id &&
        entry.event_id === row.event_id
    )
  ) {
    return makeError("duplicate key value violates unique constraint", "23505");
  }

  if (
    table === "fantasy_payouts" &&
    db.fantasy_payouts.some(
      (entry) =>
        entry.game_id === row.game_id && entry.telegram_id === row.telegram_id
    )
  ) {
    return makeError("duplicate key value violates unique constraint", "23505");
  }

  return null;
}

function computeNetPrizePool(
  db: DbState,
  gameId: string,
  commissionRate: number
): number {
  const game = db.fantasy_games.find((entry) => entry.id === gameId);
  const memberCount = db.fantasy_game_members.filter(
    (entry) => entry.game_id === gameId
  ).length;
  const entryFee = Number(game?.entry_fee ?? 0);
  const gross = roundMoney(memberCount * entryFee);
  const commission = roundMoney(gross * Math.max(0, commissionRate));
  return roundMoney(Math.max(0, gross - commission));
}

class Query {
  private readonly table: DbTableName;
  private readonly db: DbState;
  private readonly counters: Record<DbTableName, number>;
  private readonly filters: Array<(row: Record<string, unknown>) => boolean> = [];
  private action: "select" | "insert" | "update" | "delete" = "select";
  private selection = "*";
  private countRequested = false;
  private head = false;
  private ordering: { field: string; ascending: boolean } | null = null;
  private limitValue: number | null = null;
  private insertRows: Array<Record<string, unknown>> = [];
  private updatePayload: Record<string, unknown> | null = null;

  constructor(
    db: DbState,
    counters: Record<DbTableName, number>,
    table: DbTableName
  ) {
    this.db = db;
    this.counters = counters;
    this.table = table;
  }

  select(selection = "*", options: { count?: string; head?: boolean } = {}): this {
    this.selection = selection;
    this.countRequested = options.count === "exact";
    this.head = options.head === true;
    return this;
  }

  insert(payload: Record<string, unknown> | Array<Record<string, unknown>>): this {
    this.action = "insert";
    this.insertRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.action = "update";
    this.updatePayload = clone(payload);
    return this;
  }

  delete(): this {
    this.action = "delete";
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  in(field: string, values: unknown[]): this {
    const valueSet = new Set(values);
    this.filters.push((row) => valueSet.has(row[field]));
    return this;
  }

  lte(field: string, value: unknown): this {
    this.filters.push((row) => String(row[field]) <= String(value));
    return this;
  }

  gt(field: string, value: unknown): this {
    this.filters.push((row) => String(row[field]) > String(value));
    return this;
  }

  order(field: string, options: { ascending?: boolean } = {}): this {
    this.ordering = { field, ascending: options.ascending !== false };
    return this;
  }

  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  async maybeSingle(): Promise<QueryResult> {
    const result = await this.execute();
    const row = Array.isArray(result.data)
      ? (result.data[0] as Record<string, unknown> | undefined) ?? null
      : result.data;
    return { data: row, error: result.error };
  }

  async single(): Promise<QueryResult> {
    const result = await this.execute();
    const row = Array.isArray(result.data)
      ? (result.data[0] as Record<string, unknown> | undefined) ?? null
      : result.data;

    if (!row) {
      return { data: null, error: makeError("No rows returned.") };
    }

    return { data: row, error: result.error };
  }

  private get tableRows(): Array<Record<string, unknown>> {
    return this.db[this.table];
  }

  private applyFilters(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.filter((row) => rowMatches(row, this.filters));
  }

  private sortRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!this.ordering) {
      return rows;
    }

    const { field, ascending } = this.ordering;
    return [...rows].sort((left, right) => {
      if (left[field] === right[field]) {
        return 0;
      }

      return left[field]! > right[field]!
        ? ascending
          ? 1
          : -1
        : ascending
          ? -1
          : 1;
    });
  }

  private limitRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (typeof this.limitValue !== "number") {
      return rows;
    }

    return rows.slice(0, this.limitValue);
  }

  async execute(): Promise<QueryResult> {
    if (this.action === "select") {
      let rows = this.applyFilters(this.tableRows);
      const count = rows.length;
      rows = this.limitRows(this.sortRows(rows));

      return {
        data: this.head ? null : projectRows(this.db, this.table, rows, this.selection),
        error: null,
        count: this.countRequested ? count : null,
      };
    }

    if (this.action === "insert") {
      const inserted: Array<Record<string, unknown>> = [];

      for (const rawRow of this.insertRows) {
        const row = createInsertedRow(this.counters, this.table, rawRow);
        const insertError = findUniqueInsertError(this.db, this.table, row);

        if (insertError) {
          return { data: null, error: insertError };
        }

        this.tableRows.push(row);
        inserted.push(row);
      }

      return {
        data: projectRows(this.db, this.table, inserted, this.selection),
        error: null,
      };
    }

    if (this.action === "update") {
      const rows = this.applyFilters(this.tableRows);

      for (const row of rows) {
        Object.assign(row, clone(this.updatePayload ?? {}));
      }

      return {
        data: projectRows(this.db, this.table, rows, this.selection),
        error: null,
      };
    }

    const rows = this.applyFilters(this.tableRows);
    this.db[this.table] = this.tableRows.filter((row) => !rows.includes(row));

    return {
      data: projectRows(this.db, this.table, rows, this.selection),
      error: null,
    };
  }
}

function extractCallbackData(options: unknown): string | null {
  const replyMarkup = (options as { reply_markup?: { inline_keyboard?: Array<Array<Record<string, unknown>>> } } | undefined)
    ?.reply_markup;
  const firstButton = replyMarkup?.inline_keyboard?.flat()?.[0];
  const callbackData = firstButton?.callback_data;
  return typeof callbackData === "string" ? callbackData : null;
}

async function main(): Promise<void> {
  const { Api } = await import("grammy");
  const { supabase } = await import("../src/db/client.ts");
  const fantasyLeague = await import("../src/fantasy-league.ts");
  const leagueHandlers = await import("../src/bot/handlers/league.ts");

  const db: DbState = {
    fantasy_users: [],
    fantasy_revenue: [],
    fantasy_games: [],
    fantasy_game_members: [],
    fantasy_trades: [],
    fantasy_payouts: [],
  };

  const counters: Record<DbTableName, number> = {
    fantasy_users: 1,
    fantasy_revenue: 1,
    fantasy_games: 1,
    fantasy_game_members: 1,
    fantasy_trades: 1,
    fantasy_payouts: 1,
  };

  const sentMessages: Array<Record<string, unknown>> = [];
  const editedMessages: Array<Record<string, unknown>> = [];
  let nextMessageId = 100;

  Api.prototype.sendMessage = async function sendMessage(chatId, text, options) {
    const message = {
      message_id: nextMessageId++,
      chat: { id: chatId, type: "private" },
      date: Math.floor(nowMs / 1000),
      text,
      options,
    };
    sentMessages.push(message);
    return message;
  };

  Api.prototype.editMessageText = async function editMessageText(
    chatId,
    messageId,
    text,
    options
  ) {
    const message = {
      message_id: messageId,
      chat: { id: chatId, type: "private" },
      date: Math.floor(nowMs / 1000),
      text,
      options,
    };
    editedMessages.push(message);
    return message;
  };

  supabase.from = ((table: DbTableName) =>
    new Query(db, counters, table)) as typeof supabase.from;

  supabase.rpc = (async (name: string, params: Record<string, unknown>) => {
    if (name === "create_fantasy_game_with_entry") {
      const telegramId = Number(params.p_creator_telegram_id ?? 0);
      const entryFee = roundMoney(Number(params.p_entry_fee ?? 0));
      const virtualStartBalance = roundMoney(
        Number(params.p_virtual_start_balance ?? 0)
      );
      const commissionRate = Number(params.p_commission_rate ?? 0);
      const user = db.fantasy_users.find(
        (entry) => entry.telegram_id === telegramId
      );

      if (!user || Number(user.wallet_balance ?? 0) < entryFee) {
        return {
          data: null,
          error: makeError("Insufficient play balance to create an arena."),
        };
      }

      if (db.fantasy_games.some((entry) => entry.code === params.p_code)) {
        return {
          data: null,
          error: makeError("duplicate key value violates unique constraint", "23505"),
        };
      }

      user.wallet_balance = roundMoney(Number(user.wallet_balance ?? 0) - entryFee);
      user.updated_at = new Date().toISOString();

      const game = createInsertedRow(counters, "fantasy_games", {
        code: String(params.p_code ?? ""),
        creator_telegram_id: telegramId,
        asset: "BTC",
        entry_fee: entryFee,
        virtual_start_balance: virtualStartBalance,
        prize_pool: entryFee,
        status: "open",
        start_at: String(params.p_start_at ?? ""),
        end_at: String(params.p_end_at ?? ""),
      });
      db.fantasy_games.push(game);

      const member = createInsertedRow(counters, "fantasy_game_members", {
        game_id: game.id,
        telegram_id: telegramId,
        entry_fee_paid: entryFee,
        virtual_balance: virtualStartBalance,
      });
      db.fantasy_game_members.push(member);

      game.prize_pool = computeNetPrizePool(db, String(game.id), commissionRate);

      return { data: [clone(game)], error: null };
    }

    if (name === "join_fantasy_game_with_entry") {
      const code = String(params.p_code ?? "").trim().toUpperCase();
      const telegramId = Number(params.p_telegram_id ?? 0);
      const commissionRate = Number(params.p_commission_rate ?? 0);
      const game = db.fantasy_games.find((entry) => entry.code === code);

      if (!game) {
        return { data: null, error: makeError("Arena not found.") };
      }

      if (
        String(game.status) !== "open" ||
        RealDate.parse(String(game.start_at)) <= nowMs
      ) {
        return {
          data: null,
          error: makeError("This arena has already started."),
        };
      }

      if (
        db.fantasy_game_members.some(
          (entry) => entry.game_id === game.id && entry.telegram_id === telegramId
        )
      ) {
        return {
          data: null,
          error: makeError("You already joined this arena."),
        };
      }

      const user = db.fantasy_users.find(
        (entry) => entry.telegram_id === telegramId
      );
      const entryFee = Number(game.entry_fee ?? 0);

      if (!user || Number(user.wallet_balance ?? 0) < entryFee) {
        return { data: null, error: makeError("Insufficient play balance.") };
      }

      user.wallet_balance = roundMoney(Number(user.wallet_balance ?? 0) - entryFee);
      user.updated_at = new Date().toISOString();

      const member = createInsertedRow(counters, "fantasy_game_members", {
        game_id: game.id,
        telegram_id: telegramId,
        entry_fee_paid: game.entry_fee,
        virtual_balance: game.virtual_start_balance,
      });
      db.fantasy_game_members.push(member);
      game.prize_pool = computeNetPrizePool(db, String(game.id), commissionRate);

      return { data: [clone(game)], error: null };
    }

    if (name === "place_fantasy_trade_with_debit") {
      const gameId = String(params.p_game_id ?? "");
      const memberId = String(params.p_member_id ?? "");
      const telegramId = Number(params.p_telegram_id ?? 0);
      const stake = roundMoney(Number(params.p_stake ?? 0));
      const game = db.fantasy_games.find((entry) => entry.id === gameId);

      if (!game || String(game.status) !== "active") {
        return {
          data: null,
          error: makeError("This league is not active right now."),
        };
      }

      if (RealDate.parse(String(game.end_at)) <= nowMs) {
        return {
          data: null,
          error: makeError("This league has already ended."),
        };
      }

      const member = db.fantasy_game_members.find(
        (entry) =>
          entry.id === memberId &&
          entry.game_id === gameId &&
          entry.telegram_id === telegramId
      );

      if (!member) {
        return {
          data: null,
          error: makeError("You are not a member of this league."),
        };
      }

      if (
        db.fantasy_trades.some(
          (entry) =>
            entry.game_id === gameId &&
            entry.member_id === memberId &&
            entry.event_id === params.p_event_id
        )
      ) {
        return {
          data: null,
          error: makeError("You already placed a fantasy trade for this round."),
        };
      }

      if (Number(member.virtual_balance ?? 0) < stake) {
        return {
          data: null,
          error: makeError("Insufficient virtual balance."),
        };
      }

      member.virtual_balance = roundMoney(Number(member.virtual_balance ?? 0) - stake);
      member.total_trades = Number(member.total_trades ?? 0) + 1;

      const trade = createInsertedRow(counters, "fantasy_trades", {
        game_id: gameId,
        member_id: memberId,
        telegram_id: telegramId,
        event_id: params.p_event_id,
        market_id: params.p_market_id,
        direction: params.p_direction,
        stake,
        entry_price: params.p_entry_price,
        shares: params.p_shares,
        outcome: "PENDING",
        payout: 0,
      });
      db.fantasy_trades.push(trade);

      return { data: [clone(trade)], error: null };
    }

    return { data: null, error: makeError(`Unexpected RPC ${name}`) };
  }) as typeof supabase.rpc;

  function createCommandCtx(telegramId: number, text: string) {
    const replies: Array<Record<string, unknown>> = [];
    const api = {
      getMe: async () => ({ username: "betaarena_bot" }),
    };

    return {
      api,
      from: { id: telegramId, first_name: `User${telegramId}` },
      message: { text },
      reply: async (replyText: string, options?: unknown) => {
        const message = {
          message_id: nextMessageId++,
          chat: { id: telegramId, type: "private" },
          date: Math.floor(nowMs / 1000),
          text: replyText,
          options,
        };
        replies.push(message);
        return message;
      },
      replies,
    };
  }

  function createCallbackCtx(
    telegramId: number,
    chatId: number,
    messageId: number,
    data: string
  ) {
    const replies: Array<Record<string, unknown>> = [];
    const edits: Array<Record<string, unknown>> = [];
    const api = {
      getMe: async () => ({ username: "betaarena_bot" }),
    };

    return {
      api,
      from: { id: telegramId, first_name: `User${telegramId}` },
      chat: { id: chatId },
      callbackQuery: {
        data,
        message: { message_id: messageId },
      },
      editMessageText: async (text: string, options?: unknown) => {
        const message = {
          message_id: messageId,
          chat: { id: chatId, type: "private" },
          date: Math.floor(nowMs / 1000),
          text,
          options,
        };
        edits.push(message);
        editedMessages.push(message);
        return message;
      },
      reply: async (text: string, options?: unknown) => {
        const message = {
          message_id: nextMessageId++,
          chat: { id: chatId, type: "private" },
          date: Math.floor(nowMs / 1000),
          text,
          options,
        };
        replies.push(message);
        return message;
      },
      replies,
      edits,
    };
  }

  function latestPromptFor(chatId: number): Record<string, unknown> | null {
    const prompts = sentMessages.filter(
      (message) =>
        message.chat?.id === chatId &&
        typeof message.text === "string" &&
        message.text.includes("ROUND")
    );

    return (prompts[prompts.length - 1] as Record<string, unknown> | undefined) ?? null;
  }

  const createCtx = createCommandCtx(111, "/league create 5 12");
  await leagueHandlers.handleLeague(createCtx as never);
  assert(createCtx.replies.length === 1, "create flow should reply once");
  const createdReply = createCtx.replies[0];
  const createdText = String(createdReply.text ?? "");
  assert(
    createdText.includes("Arena created"),
    "create flow should confirm the arena"
  );
  const codeMatch = createdText.match(/Code: ([A-Z0-9-]+)/);
  assert(codeMatch, "create flow should return an arena code");
  const code = codeMatch?.[1] ?? "";

  const creatorWalletAfterCreate = db.fantasy_users.find(
    (entry) => entry.telegram_id === 111
  );
  assert(
    Number(creatorWalletAfterCreate?.wallet_balance ?? 0) === 35,
    "creator wallet should debit from the $40 beta balance"
  );

  const joinPreviewCtx = createCommandCtx(222, `/league join ${code}`);
  await leagueHandlers.handleLeague(joinPreviewCtx as never);
  assert(joinPreviewCtx.replies.length === 1, "join preview should reply once");
  const joinPreviewMessage = joinPreviewCtx.replies[0];
  assert(
    String(joinPreviewMessage.text ?? "").includes(`Arena ${code}`),
    "join preview should render arena details"
  );

  const joinConfirmCtx = createCallbackCtx(
    222,
    222,
    Number(joinPreviewMessage.message_id),
    "fantasy:join:confirm"
  );
  await leagueHandlers.handleFantasyJoinConfirm(joinConfirmCtx as never);
  assert(joinConfirmCtx.edits.length === 1, "join confirm should edit the preview");
  assert(
    String(joinConfirmCtx.edits[0]?.text ?? "").includes("You're in."),
    "join confirm should confirm membership"
  );

  const joinerWalletAfterJoin = db.fantasy_users.find(
    (entry) => entry.telegram_id === 222
  );
  assert(
    Number(joinerWalletAfterJoin?.wallet_balance ?? 0) === 35,
    "joiner wallet should also debit from the $40 beta balance"
  );

  nowMs = RealDate.parse("2026-04-12T12:05:05.000Z");
  await fantasyLeague.activateDueFantasyGames();

  const activatedGame = db.fantasy_games.find((entry) => entry.code === code);
  assert(activatedGame?.status === "active", "arena should activate on schedule");

  await fantasyLeague.processFantasyLeagueRound(
    {
      eventId: "evt1",
      slug: "crypto-btc-15min-1205",
      openingDate: String(eventStore.evt1.openingDate),
      closingDate: String(eventStore.evt1.closingDate),
      eventThreshold: Number(eventStore.evt1.eventThreshold),
      pctElapsed: 0.01,
    },
    {
      upPrice: 0.55,
      downPrice: 0.45,
      upOutcomeId: "yes1",
      downOutcomeId: "no1",
      eventThreshold: Number(eventStore.evt1.eventThreshold),
      eventId: "evt1",
      marketId: "mkt1",
      url: "https://bayse.markets/event/evt1",
    }
  );

  const creatorPrompt = latestPromptFor(111);
  const joinerPrompt = latestPromptFor(222);
  assert(creatorPrompt, "round prompt should reach the creator");
  assert(joinerPrompt, "round prompt should reach the joiner");

  const directionCallback = extractCallbackData(creatorPrompt?.options);
  assert(directionCallback?.startsWith("flt:b:"), "prompt should start with direction buttons");

  const directionCtx = createCallbackCtx(
    111,
    111,
    Number(creatorPrompt?.message_id),
    directionCallback ?? ""
  );
  await leagueHandlers.handleFantasyLeagueTrade(directionCtx as never);
  assert(directionCtx.edits.length === 1, "direction tap should edit the prompt");

  const stakeCallback = extractCallbackData(directionCtx.edits[0]?.options);
  assert(stakeCallback?.startsWith("flt:d:"), "direction selection should reveal stake buttons");

  const stakeCtx = createCallbackCtx(
    111,
    111,
    Number(creatorPrompt?.message_id),
    stakeCallback ?? ""
  );
  await leagueHandlers.handleFantasyLeagueTrade(stakeCtx as never);
  assert(stakeCtx.edits.length === 1, "stake tap should lock the trade");
  assert(
    String(stakeCtx.edits[0]?.text ?? "").toLowerCase().includes("locked"),
    "stake tap should render a locked trade confirmation"
  );

  const creatorMember = db.fantasy_game_members.find(
    (entry) => entry.game_id === activatedGame?.id && entry.telegram_id === 111
  );
  assert(
    Number(creatorMember?.virtual_balance ?? 0) < Number(activatedGame?.virtual_start_balance ?? 0),
    "trade placement should debit the arena stack atomically"
  );

  nowMs = RealDate.parse("2026-04-12T12:20:05.000Z");
  eventStore.evt1.status = "resolved";
  (eventStore.evt1.markets as Array<Record<string, unknown>>)[0]!.status = "resolved";
  (eventStore.evt1.markets as Array<Record<string, unknown>>)[0]!.resolvedOutcome = "YES";

  await fantasyLeague.settleFantasyLeagueTrades();

  const resultMessages = sentMessages.filter(
    (message) =>
      typeof message.text === "string" &&
      message.text.toLowerCase().includes("round 1 result")
  );
  assert(
    resultMessages.length === 2,
    "settlement should fan out one round result to each player"
  );

  const boardCtx = createCommandCtx(111, `/league board ${code}`);
  await leagueHandlers.handleLeague(boardCtx as never);
  assert(boardCtx.replies.length === 1, "leaderboard should reply once");
  assert(
    String(boardCtx.replies[0]?.text ?? "").toLowerCase().includes("you"),
    "leaderboard should personalize the viewer"
  );

  console.log(
    JSON.stringify(
      {
        code,
        starter_balance: process.env.VIRTUAL_WALLET_START_BALANCE,
        creator_wallet_after_create: creatorWalletAfterCreate?.wallet_balance,
        joiner_wallet_after_join: joinerWalletAfterJoin?.wallet_balance,
        trade_locked: String(stakeCtx.edits[0]?.text ?? "").split("\n")[0],
        round_results: resultMessages.length,
        leaderboard_headline: String(boardCtx.replies[0]?.text ?? "").split("\n")[0],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
