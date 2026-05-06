import type { Request, RequestHandler } from "express";

import { redis } from "./utils/rateLimit.ts";

interface RateLimitOptions {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
  message: string;
}

function getClientIp(req: Request): string {
  const cloudflareIp = (req.header("cf-connecting-ip") ?? "").trim();

  if (cloudflareIp) {
    return cloudflareIp;
  }

  const forwardedFor = (req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);

  if (forwardedFor) {
    return forwardedFor;
  }

  const socketAddress = req.socket.remoteAddress?.trim();

  if (socketAddress) {
    return socketAddress;
  }

  const requestIp = typeof req.ip === "string" ? req.ip.trim() : "";
  return requestIp || "unknown";
}

export function createRateLimitMiddleware(
  options: RateLimitOptions
): RequestHandler {
  return async (req, res, next) => {
    const clientIp = getClientIp(req);
    const key = `rate_limit:${options.keyPrefix}:${clientIp}`;

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, options.windowSeconds);
      }

      res.setHeader("X-RateLimit-Limit", String(options.limit));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, options.limit - current))
      );
      res.setHeader("X-RateLimit-Window", String(options.windowSeconds));

      if (current > options.limit) {
        res.setHeader("Retry-After", String(options.windowSeconds));
        res.status(429).type("text/plain").send(options.message);
        return;
      }
    } catch (error) {
      console.warn(
        `[security] Rate limit check failed for ${options.keyPrefix}:`,
        error
      );
    }

    next();
  };
}
