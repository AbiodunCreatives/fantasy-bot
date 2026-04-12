import Redis from "ioredis";

import { config } from "../config.ts";

type RedisSetMode = "EX";

interface CacheClient {
  set(
    key: string,
    value: string,
    mode?: RedisSetMode,
    durationSeconds?: number
  ): Promise<"OK">;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  dbsize(): Promise<number>;
  ping(): Promise<"PONG">;
  quit(): Promise<"OK">;
  disconnect(): void;
}

interface MemoryValue {
  value: string;
  expiresAt: number | null;
}

class MemoryCacheClient implements CacheClient {
  private readonly store = new Map<string, MemoryValue>();

  constructor() {
    console.warn(
      "[redis] REDIS_MODE=memory enabled. Ephemeral in-memory cache will be used."
    );
  }

  async set(
    key: string,
    value: string,
    mode?: RedisSetMode,
    durationSeconds?: number
  ): Promise<"OK"> {
    let expiresAt: number | null = null;

    if (mode !== undefined) {
      if (mode !== "EX" || !Number.isFinite(durationSeconds) || !durationSeconds) {
        throw new Error("Memory cache only supports set(key, value, 'EX', seconds).");
      }

      expiresAt = Date.now() + durationSeconds * 1000;
    }

    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.purgeExpiredKey(key);
    return this.store.get(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;

    for (const key of keys) {
      this.purgeExpiredKey(key);

      if (this.store.delete(key)) {
        deleted += 1;
      }
    }

    return deleted;
  }

  async incr(key: string): Promise<number> {
    this.purgeExpiredKey(key);

    const current = this.store.get(key);
    const currentValue = current?.value ?? "0";
    const nextValue = Number.parseInt(currentValue, 10);

    if (!Number.isFinite(nextValue)) {
      throw new Error(`Memory cache value for ${key} is not an integer.`);
    }

    const next = nextValue + 1;

    this.store.set(key, {
      value: String(next),
      expiresAt: current?.expiresAt ?? null,
    });

    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.purgeExpiredKey(key);

    const current = this.store.get(key);

    if (!current) {
      return 0;
    }

    this.store.set(key, {
      ...current,
      expiresAt: Date.now() + seconds * 1000,
    });

    return 1;
  }

  async dbsize(): Promise<number> {
    this.purgeExpiredKeys();
    return this.store.size;
  }

  async ping(): Promise<"PONG"> {
    return "PONG";
  }

  async quit(): Promise<"OK"> {
    this.store.clear();
    return "OK";
  }

  disconnect(): void {
    this.store.clear();
  }

  private purgeExpiredKeys(): void {
    for (const key of this.store.keys()) {
      this.purgeExpiredKey(key);
    }
  }

  private purgeExpiredKey(key: string): void {
    const value = this.store.get(key);

    if (!value || value.expiresAt === null) {
      return;
    }

    if (value.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }
}

function wrapRedisClient(client: Redis): CacheClient {
  return {
    async set(
      key: string,
      value: string,
      mode?: RedisSetMode,
      durationSeconds?: number
    ): Promise<"OK"> {
      if (mode === undefined) {
        return client.set(key, value);
      }

      return client.set(key, value, mode, durationSeconds ?? 0);
    },
    get(key: string): Promise<string | null> {
      return client.get(key);
    },
    del(...keys: string[]): Promise<number> {
      return client.del(...keys);
    },
    incr(key: string): Promise<number> {
      return client.incr(key);
    },
    expire(key: string, seconds: number): Promise<number> {
      return client.expire(key, seconds);
    },
    dbsize(): Promise<number> {
      return client.dbsize();
    },
    async ping(): Promise<"PONG"> {
      await client.ping();
      return "PONG";
    },
    async quit(): Promise<"OK"> {
      await client.quit();
      return "OK";
    },
    disconnect(): void {
      client.disconnect();
    },
  };
}

function createRedisClient(): CacheClient {
  if (config.REDIS_MODE === "memory") {
    return new MemoryCacheClient();
  }

  const redisUrl = config.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL is required when REDIS_MODE=redis.");
  }

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 5000,
  });

  client.on("connect", () => console.log("[redis] Connecting..."));
  client.on("ready", () => console.log("[redis] Ready."));
  client.on("error", (error) => console.error("[redis] Error:", error.message));
  client.on("close", () => console.warn("[redis] Connection closed."));
  client.on("reconnecting", () => console.log("[redis] Reconnecting..."));

  return wrapRedisClient(client);
}

export const redis = createRedisClient();
