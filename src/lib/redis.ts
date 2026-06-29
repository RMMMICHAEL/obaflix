/**
 * Cliente Redis compartilhado.
 *
 * Em produção (Vercel): configure UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 * Em desenvolvimento: se as variáveis estiverem ausentes, um stub in-memory é usado
 * automaticamente — sem erros, sem configuração extra.
 *
 * API mínima exposta (o suficiente para os casos de uso de segurança):
 *   set(key, value, opts?)  → "OK" | null
 *   get(key)                → string | null
 *   del(key)                → number
 *   incr(key)               → number
 *   expire(key, seconds)    → number
 *   zadd(key, ...)          → number
 *   zremrangebyscore(key, min, max) → number
 *   zcard(key)              → number
 */

export interface RedisClient {
  set(key: string, value: string | number, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
}

// ── Stub in-memory (desenvolvimento / fallback) ───────────────────────────────

class MemoryStore implements RedisClient {
  private kv = new Map<string, { value: string; expiresAt?: number }>();
  private zsets = new Map<string, Map<string, number>>(); // key → member → score

  private isExpired(entry: { expiresAt?: number }): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt < Date.now();
  }

  async set(key: string, value: string | number, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null> {
    const existing = this.kv.get(key);
    if (opts?.nx && existing && !this.isExpired(existing)) return null;
    this.kv.set(key, {
      value: String(value),
      expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined,
    });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const entry = this.kv.get(key);
    if (!entry || this.isExpired(entry)) { this.kv.delete(key); return null; }
    return entry.value;
  }

  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const entry = this.kv.get(key);
    const cur = entry && !this.isExpired(entry) ? parseInt(entry.value, 10) : 0;
    const next = cur + 1;
    this.kv.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.kv.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    const zset = this.zsets.get(key)!;
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const [member, score] of zset) {
      if (score >= min && score <= max) { zset.delete(member); removed++; }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }
}

// ── Upstash Redis (produção) ──────────────────────────────────────────────────

function buildUpstashClient(): RedisClient | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  // Importação dinâmica para não quebrar builds sem as variáveis configuradas
  const { Redis } = require("@upstash/redis");
  const client = new Redis({ url, token });

  return {
    async set(key, value, opts) {
      const args: any = { ex: opts?.ex, nx: opts?.nx };
      // remove undefined keys para a SDK não reclamar
      Object.keys(args).forEach(k => args[k] === undefined && delete args[k]);
      return client.set(key, String(value), Object.keys(args).length ? args : undefined);
    },
    get: (key) => client.get(key),
    del: (key) => client.del(key),
    incr: (key) => client.incr(key),
    expire: (key, seconds) => client.expire(key, seconds),
    async zadd(key, score, member) {
      return client.zadd(key, { score, member });
    },
    zremrangebyscore: (key, min, max) => client.zremrangebyscore(key, min, max),
    zcard: (key) => client.zcard(key),
  };
}

// Singleton — instanciado uma vez por processo (sobrevive entre requests no mesmo worker warm)
let _client: RedisClient | null = null;

export function getRedis(): RedisClient {
  if (!_client) {
    _client = buildUpstashClient() ?? new MemoryStore();
  }
  return _client;
}

export const isRedisConnected = (): boolean =>
  !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
