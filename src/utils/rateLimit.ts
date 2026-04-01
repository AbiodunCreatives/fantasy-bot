import Redis from "ioredis";

import { config } from "../config.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: true,
  connectTimeout: 5000,
});

redis.on("connect", () => console.log("[redis] Connecting..."));
redis.on("ready", () => console.log("[redis] Ready."));
redis.on("error", (error) => console.error("[redis] Error:", error.message));
redis.on("close", () => console.warn("[redis] Connection closed."));
redis.on("reconnecting", () => console.log("[redis] Reconnecting..."));
