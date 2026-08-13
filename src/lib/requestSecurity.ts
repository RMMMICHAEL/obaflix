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

export async function readJsonBody<T = Record<string, unknown>>(
  req: Request,
  maxBytes = 16 * 1024,
): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("corpo muito grande");
  if (!req.body) throw new Error("corpo ausente");

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("corpo muito grande");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as T;
}
