// @ts-nocheck

process.env.BOT_TOKEN = "123:TEST";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.NODE_ENV = "test";

const RealDate = Date;
let nowMs = RealDate.parse("2026-04-12T12:00:00.000Z");

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(nowMs);
      return;
    }

    super(...args);
  }

  static now() {
    return nowMs;
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
}

globalThis.Date = FakeDate;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const eventStore = {
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

globalThis.fetch = async (input) => {
  const url = new URL(String(input));

  if (url.pathname === "/v1/pm/events") {
    return {
      ok: true,
      status: 200,
      json: async () => ({ events: Object.values(eventStore).map(clone) }),
      text: async () => "",
    };
  }

  const match = url.pathname.match(/^\/v1\/pm\/events\/([^/]+)$/);

  if (match) {
    const event = eventStore[match[1]];

    if (!event) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "Not found",
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => clone(event),
      text: async () => "",
    };
  }

  throw new Error(`Unexpected fetch URL: ${url.toString()}`);
};

const { Api } = await import("grammy");

const sentMessages = [];
const editedMessages = [];
const messageStore = new Map();
let nextMessageId = 100;

Api.prototype.sendMessage = async function sendMessage(chatId, text, options) {
  const message = {
    message_id: nextMessageId++,
    chat: { id: chatId, type: "private" },
    date: Math.floor(nowMs / 1000),
    text,
  };

  messageStore.set(`${chatId}:${message.message_id}`, {
    chatId,
    messageId: message.message_id,
    text,
    options,
  });
  sentMessages.push({ chatId, messageId: message.message_id, text, options });
  return message;
};

Api.prototype.editMessageText = async function editMessageText(
  chatId,
  messageId,
  text,
  options
) {
  messageStore.set(`${chatId}:${messageId}`, {
    chatId,
    messageId,
    text,
    options,
  });
  editedMessages.push({ chatId, messageId, text, options });
  return {
    message_id: messageId,
    chat: { id: chatId, type: "private" },
    date: Math.floor(nowMs / 1000),
    text,
  };
};

const { redis } = await import("../src/utils/rateLimit.ts");
const { supabase } = await import("../src/db/client.ts");
const fantasyLeague = await import("../src/fantasy-league.ts");
const leagueHandlers = await import("../src/bot/handlers/league.ts");

const redisStore = new Map();
const redisExpiries = new Map();

function pruneRedisKey(key) {
  const expiry = redisExpiries.get(key);

  if (expiry !== undefined && expiry <= nowMs) {
    redisStore.delete(key);
    redisExpiries.delete(key);
  }
}

redis.set = async (key, value, mode, ttlMode, ttlSeconds) => {
  redisStore.set(key, String(value));

  if (mode === "EX") {
    redisExpiries.set(key, nowMs + Number(ttlMode) * 1000);
  } else if (ttlMode === "EX") {
    redisExpiries.set(key, nowMs + Number(ttlSeconds) * 1000);
  } else {
    redisExpiries.delete(key);
  }

  return "OK";
};

redis.get = async (key) => {
  pruneRedisKey(key);
  return redisStore.has(key) ? redisStore.get(key) : null;
};

redis.del = async (...keys) => {
  let deleted = 0;

  for (const key of keys.flat()) {
    pruneRedisKey(key);

    if (redisStore.delete(key)) {
      redisExpiries.delete(key);
      deleted += 1;
    }
  }

  return deleted;
};

redis.incr = async (key) => {
  pruneRedisKey(key);
  const next = Number(redisStore.get(key) ?? "0") + 1;
  redisStore.set(key, String(next));
  return next;
};

redis.expire = async (key, seconds) => {
  pruneRedisKey(key);

  if (!redisStore.has(key)) {
    return 0;
  }

  redisExpiries.set(key, nowMs + seconds * 1000);
  return 1;
};

redis.ping = async () => "PONG";
redis.dbsize = async () => redisStore.size;
redis.quit = async () => "OK";
redis.disconnect = () => undefined;

const db = {
  fantasy_games: [],
  fantasy_game_members: [],
  fantasy_trades: [],
  fantasy_payouts: [],
  user_access: [
    { telegram_id: "111", balance: 100 },
    { telegram_id: "222", balance: 100 },
  ],
  users: [
    { telegram_id: 111, username: "alpha" },
    { telegram_id: 222, username: "beta" },
  ],
};

const idCounters = {
  fantasy_games: 1,
  fantasy_game_members: 1,
  fantasy_trades: 1,
  fantasy_payouts: 1,
};

function projectRows(table, rows, selection) {
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
    const projected = {};

    for (const column of columns) {
      projected[column] = row[column];
    }

    return clone(projected);
  });
}

function buildInsertedRow(table, row) {
  const nextRow = clone(row);

  if (table === "fantasy_games") {
    nextRow.id = nextRow.id ?? `game_${idCounters.fantasy_games++}`;
    nextRow.created_at = nextRow.created_at ?? new Date().toISOString();
    nextRow.status = nextRow.status ?? "open";
    nextRow.last_round_event_id = nextRow.last_round_event_id ?? null;
    nextRow.completed_at = nextRow.completed_at ?? null;
    nextRow.cancelled_at = nextRow.cancelled_at ?? null;
    return nextRow;
  }

  if (table === "fantasy_game_members") {
    nextRow.id = nextRow.id ?? `member_${idCounters.fantasy_game_members++}`;
    nextRow.joined_at = nextRow.joined_at ?? new Date().toISOString();
    nextRow.total_trades = nextRow.total_trades ?? 0;
    nextRow.wins = nextRow.wins ?? 0;
    nextRow.losses = nextRow.losses ?? 0;
    nextRow.prize_awarded = nextRow.prize_awarded ?? 0;
    return nextRow;
  }

  if (table === "fantasy_trades") {
    nextRow.id = nextRow.id ?? `trade_${idCounters.fantasy_trades++}`;
    nextRow.created_at = nextRow.created_at ?? new Date().toISOString();
    nextRow.resolved_at = nextRow.resolved_at ?? null;
    return nextRow;
  }

  if (table === "fantasy_payouts") {
    nextRow.id = nextRow.id ?? `payout_${idCounters.fantasy_payouts++}`;
    return nextRow;
  }

  return nextRow;
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.action = "select";
    this.selection = "*";
    this.countRequested = false;
    this.head = false;
    this.ordering = null;
    this.limitValue = null;
    this.insertRows = [];
    this.updatePayload = null;
  }

  select(selection = "*", options = {}) {
    this.selection = selection;
    this.countRequested = options.count === "exact";
    this.head = options.head === true;
    return this;
  }

  insert(payload) {
    this.action = "insert";
    this.insertRows = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload) {
    this.action = "update";
    this.updatePayload = clone(payload);
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  in(field, values) {
    const valueSet = new Set(values);
    this.filters.push((row) => valueSet.has(row[field]));
    return this;
  }

  lte(field, value) {
    this.filters.push((row) => row[field] <= value);
    return this;
  }

  gt(field, value) {
    this.filters.push((row) => row[field] > value);
    return this;
  }

  order(field, options = {}) {
    this.ordering = { field, ascending: options.ascending !== false };
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async maybeSingle() {
    const result = await this.execute();
    const row = Array.isArray(result.data) ? result.data[0] ?? null : result.data ?? null;
    return { data: row, error: result.error };
  }

  async single() {
    const result = await this.execute();
    const row = Array.isArray(result.data) ? result.data[0] ?? null : result.data ?? null;

    if (!row) {
      return { data: null, error: new Error("No rows returned.") };
    }

    return { data: row, error: result.error };
  }

  applyFilters(rows) {
    return rows.filter((row) => this.filters.every((filter) => filter(row)));
  }

  sortRows(rows) {
    if (!this.ordering) {
      return rows;
    }

    const { field, ascending } = this.ordering;
    return [...rows].sort((left, right) => {
      if (left[field] === right[field]) {
        return 0;
      }

      return left[field] > right[field]
        ? ascending
          ? 1
          : -1
        : ascending
          ? -1
          : 1;
    });
  }

  limitRows(rows) {
    if (typeof this.limitValue !== "number") {
      return rows;
    }

    return rows.slice(0, this.limitValue);
  }

  async execute() {
    const tableRows = db[this.table];

    if (this.action === "select") {
      let rows = this.applyFilters(tableRows);
      const count = rows.length;
      rows = this.limitRows(this.sortRows(rows));

      return {
        data: this.head ? null : projectRows(this.table, rows, this.selection),
        error: null,
        count: this.countRequested ? count : null,
      };
    }

    if (this.action === "insert") {
      const inserted = this.insertRows.map((row) => buildInsertedRow(this.table, row));
      tableRows.push(...inserted);

      return {
        data: projectRows(this.table, inserted, this.selection),
        error: null,
      };
    }

    if (this.action === "update") {
      const rows = this.applyFilters(tableRows);

      for (const row of rows) {
        Object.assign(row, clone(this.updatePayload));
      }

      return {
        data: projectRows(this.table, rows, this.selection),
        error: null,
      };
    }

    if (this.action === "delete") {
      const rows = this.applyFilters(tableRows);
      db[this.table] = tableRows.filter((row) => !rows.includes(row));

      return {
        data: projectRows(this.table, rows, this.selection),
        error: null,
      };
    }

    throw new Error(`Unsupported action ${this.action}`);
  }
}

supabase.from = (table) => new Query(table);
supabase.rpc = async (name, params) => {
  if (name !== "apply_balance_delta") {
    throw new Error(`Unexpected RPC ${name}`);
  }

  const telegramId = String(params.p_telegram_id);
  const delta = Number(params.p_delta);
  const allowNegative = params.p_allow_negative === true;
  const row =
    db.user_access.find((entry) => entry.telegram_id === telegramId) ??
    (() => {
      const created = { telegram_id: telegramId, balance: 0 };
      db.user_access.push(created);
      return created;
    })();
  const balanceBefore = roundMoney(Number(row.balance ?? 0));
  const balanceAfter = roundMoney(balanceBefore + delta);

  if (!allowNegative && balanceAfter < 0) {
    return {
      data: [
        {
          success: false,
          balance_before: balanceBefore,
          balance_after: balanceBefore,
        },
      ],
      error: null,
    };
  }

  row.balance = balanceAfter;

  return {
    data: [
      {
        success: true,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
      },
    ],
    error: null,
  };
};

function createCommandCtx(telegramId, text) {
  const replies = [];

  return {
    from: { id: telegramId },
    message: { text },
    reply: async (replyText, options) => {
      replies.push({ text: replyText, options });
      return { message_id: nextMessageId++ };
    },
    replies,
  };
}

function createCallbackCtx(telegramId, chatId, messageId, data) {
  const replies = [];
  const edits = [];

  return {
    from: { id: telegramId },
    chat: { id: chatId },
    callbackQuery: {
      data,
      message: { message_id: messageId },
    },
    editMessageText: async (text, options) => {
      edits.push({ text, options });
      messageStore.set(`${chatId}:${messageId}`, {
        chatId,
        messageId,
        text,
        options,
      });
      editedMessages.push({ chatId, messageId, text, options });
      return true;
    },
    reply: async (text, options) => {
      replies.push({ text, options });
      return { message_id: nextMessageId++ };
    },
    replies,
    edits,
  };
}

function latestPromptFor(chatId) {
  const prompts = sentMessages.filter(
    (message) =>
      message.chatId === chatId &&
      typeof message.text === "string" &&
      message.text.toLowerCase().includes("arena")
  );

  return prompts[prompts.length - 1] ?? null;
}

function findTradeRef(eventId) {
  for (const key of redisStore.keys()) {
    if (!key.startsWith("fantasy:trade:")) {
      continue;
    }

    const raw = redisStore.get(key);
    const parsed = JSON.parse(raw);

    if (parsed.eventId === eventId) {
      return key.slice("fantasy:trade:".length);
    }
  }

  return null;
}

try {
  const createCtx = createCommandCtx(111, "/league create 5");
  await leagueHandlers.handleLeague(createCtx);
  assert(createCtx.replies.length === 1, "create flow should reply once");
  const codeMatch = createCtx.replies[0].text.match(/League Code: ([A-Z0-9-]+)/);
  assert(codeMatch, "create flow should return a league code");
  const code = codeMatch[1];

  const joinPreviewCtx = createCommandCtx(222, `/league join ${code}`);
  await leagueHandlers.handleLeague(joinPreviewCtx);
  assert(joinPreviewCtx.replies.length === 1, "join preview should reply once");
  assert(
    joinPreviewCtx.replies[0].text.includes("BAYSE FANTASY ARENA"),
    "join preview text should render"
  );

  const joinConfirmCtx = createCallbackCtx(222, 222, 1, "fantasy:join:confirm");
  await leagueHandlers.handleFantasyJoinConfirm(joinConfirmCtx);
  assert(joinConfirmCtx.replies.length === 1, "join confirm should reply once");
  assert(
    joinConfirmCtx.replies[0].text.includes("You're in. Welcome to the arena."),
    "join confirm text should render"
  );

  nowMs = RealDate.parse("2026-04-12T12:05:05.000Z");
  await fantasyLeague.activateDueFantasyGames();

  await fantasyLeague.processFantasyLeagueRound(
    {
      eventId: "evt1",
      slug: "crypto-btc-15min-1205",
      openingDate: eventStore.evt1.openingDate,
      closingDate: eventStore.evt1.closingDate,
      eventThreshold: eventStore.evt1.eventThreshold,
      pctElapsed: 0.01,
    },
    {
      upPrice: 0.55,
      downPrice: 0.45,
      upOutcomeId: "yes1",
      downOutcomeId: "no1",
      eventThreshold: eventStore.evt1.eventThreshold,
      eventId: "evt1",
      marketId: "mkt1",
      url: "https://bayse.markets/event/evt1",
    }
  );

  const promptRoundOneUserOne = latestPromptFor(111);
  const promptRoundOneUserTwo = latestPromptFor(222);
  assert(promptRoundOneUserOne, "round one prompt should be sent to creator");
  assert(promptRoundOneUserTwo, "round one prompt should be sent to joiner");

  const refRoundOne = findTradeRef("evt1");
  assert(refRoundOne, "round one trade ref should be stored");

  const stakeCtx = createCallbackCtx(
    111,
    111,
    promptRoundOneUserOne.messageId,
    `flt:s:25:r:${refRoundOne}`
  );
  await leagueHandlers.handleFantasyLeagueTrade(stakeCtx);
  assert(stakeCtx.edits.length === 1, "stake tap should edit the prompt in place");
  assert(
    stakeCtx.edits[0].text.toLowerCase().includes("which direction"),
    "stake tap should switch prompt into direction mode"
  );
  assert(stakeCtx.replies.length === 0, "stake tap should not send a new message");

  const directionCtx = createCallbackCtx(
    111,
    111,
    promptRoundOneUserOne.messageId,
    `flt:d:25:UP:r:${refRoundOne}`
  );
  await leagueHandlers.handleFantasyLeagueTrade(directionCtx);
  assert(directionCtx.edits.length === 1, "direction tap should edit the prompt in place");
  assert(
    directionCtx.edits[0].text.includes("locked in"),
    "direction tap should render a locked trade confirmation"
  );
  assert(directionCtx.replies.length === 0, "direction tap should not send a new message");

  nowMs = RealDate.parse("2026-04-12T12:20:05.000Z");
  eventStore.evt1.status = "resolved";
  eventStore.evt1.markets[0].status = "resolved";
  eventStore.evt1.markets[0].resolvedOutcome = "YES";

  await fantasyLeague.settleFantasyLeagueTrades();

  const resultMessages = sentMessages.filter(
    (message) =>
      typeof message.text === "string" &&
      message.text.toLowerCase().includes("round 1 result")
  );
  assert(resultMessages.length === 2, "settlement should fan out one result message per player");

  const boardCtx = createCommandCtx(111, `/league board ${code}`);
  await leagueHandlers.handleLeague(boardCtx);
  assert(boardCtx.replies.length === 1, "board should reply once");
  assert(boardCtx.replies[0].text.includes("you"), "leaderboard should personalize the viewer");

  await fantasyLeague.processFantasyLeagueRound(
    {
      eventId: "evt2",
      slug: "crypto-btc-15min-1220",
      openingDate: eventStore.evt2.openingDate,
      closingDate: eventStore.evt2.closingDate,
      eventThreshold: eventStore.evt2.eventThreshold,
      pctElapsed: 0.01,
    },
    {
      upPrice: 0.51,
      downPrice: 0.49,
      upOutcomeId: "yes2",
      downOutcomeId: "no2",
      eventThreshold: eventStore.evt2.eventThreshold,
      eventId: "evt2",
      marketId: "mkt2",
      url: "https://bayse.markets/event/evt2",
    }
  );

  const promptRoundTwoUserOne = latestPromptFor(111);
  const promptRoundTwoUserTwo = latestPromptFor(222);
  assert(promptRoundTwoUserOne, "round two prompt should be sent to creator");
  assert(promptRoundTwoUserTwo, "round two prompt should be sent to joiner");

  const refRoundTwo = findTradeRef("evt2");
  assert(refRoundTwo, "round two trade ref should be stored");

  const edgeStakeCtx = createCallbackCtx(
    111,
    111,
    promptRoundTwoUserOne.messageId,
    `flt:s:10:r:${refRoundTwo}`
  );
  await leagueHandlers.handleFantasyLeagueTrade(edgeStakeCtx);
  assert(
    edgeStakeCtx.edits.length === 1 &&
      edgeStakeCtx.edits[0].text.toLowerCase().includes("which direction"),
    "edge-case stake tap should still edit in place"
  );

  nowMs = RealDate.parse("2026-04-12T12:35:05.000Z");

  const edgeDirectionCtx = createCallbackCtx(
    111,
    111,
    promptRoundTwoUserOne.messageId,
    `flt:d:10:DOWN:r:${refRoundTwo}`
  );
  await leagueHandlers.handleFantasyLeagueTrade(edgeDirectionCtx);
  assert(
    edgeDirectionCtx.edits.length === 1,
    "expired direction tap should edit the original prompt"
  );
  assert(
    edgeDirectionCtx.edits[0].text.includes("No trade was placed."),
    "expired direction tap should render the warm closed-round message"
  );
  assert(
    edgeDirectionCtx.replies.length === 0,
    "expired direction tap should not send a fallback error message"
  );

  fantasyLeague.clearFantasyTradePromptState(222, promptRoundOneUserTwo.messageId);
  fantasyLeague.clearFantasyTradePromptState(111, promptRoundTwoUserOne.messageId);
  fantasyLeague.clearFantasyTradePromptState(222, promptRoundTwoUserTwo.messageId);

  console.log(
    JSON.stringify(
      {
        code,
        createdReply: createCtx.replies[0].text.split("\n")[0],
        lockedTrade: directionCtx.edits[0].text.split("\n")[0],
        closedEdgeCase: edgeDirectionCtx.edits[0].text.split("\n")[0],
        leaderboardHeadline: boardCtx.replies[0].text.split("\n")[0],
        resultMessages: resultMessages.length,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
