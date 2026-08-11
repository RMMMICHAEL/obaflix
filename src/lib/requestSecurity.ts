import { NextRequest } from "next/server";
import { getRedis } from "@/lib/redis";

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
}

export function headerMatchesHost(value: string, host: string): boolean {
  try {
    return new URL(value).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export async function checkRateLimit(key: string, limit: number, windowSeconds: number) {
  const redis = getRedis();
  const count = await redis.incr(`http:rate:${key}`);
  if (count === 1) await redis.expire(`http:rate:${key}`, windowSeconds);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}
