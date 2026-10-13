import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getRedis, type RedisClient } from "../redis";
import { emitirConcessao, marcarPago, type AlvoDeConcessao, type FinalidadeDeConcessao } from "./concessoes";

const TTL = 10 * 60;
const RETENTION = 9 * 24 * 60 * 60; // Exceeds the provider's eight-day retry window.
const prefix = "ads:levelplay:v2:";
// The published signature does not authenticate format/app/build scope. Env flags
// cannot assert a missing cryptographic guarantee. Requires a reviewed protocol change.
export const LEVELPLAY_SIGNED_SCOPE_SUPPORTED = false;
export function rewardedConfigurado(env: Record<string, string | undefined> = process.env): boolean {
  return LEVELPLAY_SIGNED_SCOPE_SUPPORTED && env.LEVELPLAY_REWARDED_ENABLED === "true" &&
    env.LEVELPLAY_S2S_VALIDATED === "true" &&
    (env.LEVELPLAY_S2S_PRIVATE_KEY?.length ?? 0) >= 32;
}
export function s2sReceiverConfigurado(env: Record<string, string | undefined> = process.env): boolean {
  return env.LEVELPLAY_S2S_RECEIVER_ENABLED === "true" &&
    (env.LEVELPLAY_S2S_PRIVATE_KEY?.length ?? 0) >= 32 &&
    !!env.UPSTASH_REDIS_REST_URL && !!env.UPSTASH_REDIS_REST_TOKEN;
}
interface Challenge {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  alvo: AlvoDeConcessao;
  created: number;
  expires: number;
  distribution: "play" | "direct";
  format: "rewarded";
}
export interface Commission {
  applicationUserId: string;
  eventId: string;
  timestamp: string;
  rewards: string;
  signature: string;
}
// The official timestamp is YYYYMMDDHHMM (callback time, not impression time).
export function callbackTime(value: string): number | null {
  if (!/^\d{12}$/.test(value)) return null;
  const parts = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8), value.slice(8, 10), value.slice(10, 12)].map(Number);
  const time = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  const date = new Date(time);
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 12) === value ? time : null;
}
export function autenticarCommission(input: Commission, secret: string, now: number): boolean {
  const time = callbackTime(input.timestamp);
  if (secret.length < 32 || !/^[a-f0-9]{48}$/.test(input.applicationUserId) ||
      !/^[a-zA-Z0-9]{1,128}$/.test(input.eventId) || input.rewards !== "1" ||
      !/^[a-fA-F0-9]{32}$/.test(input.signature) || time === null ||
      time > now + 60_000 || now - time > RETENTION * 1000) return false;
  const expected = createHash("md5").update(input.timestamp + input.eventId + input.applicationUserId + input.rewards + secret, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(input.signature, "hex"));
}

/** Each signed SDK initialization user ID belongs to exactly ONE challenge.
 * Dynamic/custom IDs are unsigned in the documented protocol and never authority.
 * A provider must refuse to reuse its initialized user ID for another challenge.
 */
export class LevelPlayRewards {
  constructor(private readonly redis: RedisClient = persistentRewardStore(), private readonly now = Date.now,
    private readonly emit = emitirConcessao, private readonly markPaid = marcarPago) {}
  private async metric(event: "s2s_verified" | "grant") {
    const key = `${prefix}metric:${new Date(this.now()).toISOString().slice(0, 10)}:${event}`;
    try { await this.redis.incr(key); await this.redis.expire(key, RETENTION); } catch { /* Metrics cannot change authorization. */ }
  }

  private scope(input: Pick<Challenge, "userId" | "distribution">): string {
    return prefix + "active:" + createHash("sha256").update(JSON.stringify([input.distribution, input.userId])).digest("hex");
  }
  async open(input: Omit<Challenge, "created" | "expires" | "format" | "distribution"> & { distribution?: "play" | "direct" }): Promise<string> {
    const distribution = input.distribution ?? "play";
    if (!input.userId || !["play", "direct"].includes(distribution) ||
        !["reproducao", "download", "transmissao"].includes(input.finalidade) || !input.alvo?.conteudoId) throw new Error("Invalid rewarded scope");
    const id = randomBytes(24).toString("hex");
    const created = this.now();
    const challenge: Challenge = { ...input, distribution, format: "rewarded", created, expires: created + TTL * 1000 };
    if (!await this.redis.set(this.scope(challenge), id, { nx: true, ex: TTL })) throw new Error("Rewarded operation already active");
    // A failed/ambiguous write keeps the scope reserved until expiry, never rebinds it.
    if (!await this.redis.set(prefix + "challenge:" + id, JSON.stringify(challenge), { nx: true, ex: RETENTION })) throw new Error("Rewarded challenge not persisted");
    return id;
  }

  async cancel(id: string, userId: string, distribution: "play" | "direct" = "play"): Promise<boolean> {
    if (!/^[a-f0-9]{48}$/.test(id)) return false;
    const raw = await this.redis.get(prefix + "challenge:" + id);
    if (!raw) return false;
    const challenge: Challenge = JSON.parse(raw);
    if (challenge.userId !== userId || challenge.distribution !== distribution) return false;
    const terminal = prefix + "terminal:" + id;
    const won = await this.redis.set(terminal, "cancelled", { nx: true, ex: RETENTION });
    if (!won && await this.redis.get(terminal) !== "cancelled") return false;
    await this.redis.compareAndDelete(this.scope(challenge), id);
    return true;
  }

  async callback(input: Commission, secret: string): Promise<"ok" | "invalid" | "expired"> {
    if (!autenticarCommission(input, secret, this.now())) return "invalid";
    const eventKey = prefix + "event:" + input.eventId;
    const existing = await this.redis.get(eventKey);
    if (existing && existing !== input.applicationUserId) return "invalid";
    const key = prefix + "challenge:" + input.applicationUserId;
    const raw = await this.redis.get(key);
    if (!raw) return "expired";
    const challenge: Challenge = JSON.parse(raw);
    if (challenge.format !== "rewarded" || !["play", "direct"].includes(challenge.distribution)) return "invalid";
    const proofKey = prefix + "proof:" + input.applicationUserId;
    const proof = await this.redis.get(proofKey);
    if (proof) return proof === input.eventId && existing === input.applicationUserId ? "ok" : "invalid";
    if (await this.redis.get(prefix + "terminal:" + input.applicationUserId) === "cancelled") return "invalid";
    if (this.now() > challenge.expires) return "expired";
    if (await this.redis.get(this.scope(challenge)) !== input.applicationUserId) return "invalid";
    const timestamp = callbackTime(input.timestamp)!;
    if (timestamp + 60_000 < challenge.created) return "invalid";
    // Globally unique event, then unique proof per challenge. No client route writes proof.
    await this.redis.set(eventKey, input.applicationUserId, { nx: true, ex: RETENTION });
    if (await this.redis.get(eventKey) !== input.applicationUserId) return "invalid";
    const inserted = await this.redis.set(proofKey, input.eventId, { nx: true, ex: RETENTION });
    if (inserted) await this.metric("s2s_verified");
    // ACK only when BOTH reservations are persisted. A partial write is retryable,
    // never proof for a different challenge. Cancel/consume compete on one NX key.
    return await this.redis.get(eventKey) === input.applicationUserId &&
      await this.redis.get(proofKey) === input.eventId ? "ok" : "invalid";
  }

  async status(id: string, userId: string, distribution: "play" | "direct" = "play"): Promise<{ state: "pending" | "unavailable" | "verified"; concessao?: string }> {
    // Receipt validation is not authorization to issue a production grant.
    // Synthetic emitters are used only by isolated tests; real grants fail closed.
    if (this.emit === emitirConcessao && !rewardedConfigurado()) return { state: "unavailable" };
    if (!/^[a-f0-9]{48}$/.test(id)) return { state: "unavailable" };
    const raw = await this.redis.get(prefix + "challenge:" + id);
    if (!raw) return { state: "unavailable" };
    const challenge: Challenge = JSON.parse(raw);
    if (challenge.userId !== userId || challenge.distribution !== distribution || challenge.format !== "rewarded") return { state: "unavailable" };
    const terminalKey = prefix + "terminal:" + id;
    if (await this.redis.get(terminalKey) === "cancelled") return { state: "unavailable" };
    const resultKey = prefix + "grant:" + id;
    const granted = await this.redis.get(resultKey);
    if (granted) return { state: "verified", concessao: granted };
    if (this.now() > challenge.expires) return { state: "unavailable" };
    if (await this.redis.get(this.scope(challenge)) !== id) return { state: "unavailable" };
    const proof = await this.redis.get(prefix + "proof:" + id);
    if (!proof || await this.redis.get(prefix + "event:" + proof) !== id) return { state: "pending" };
    // Permanent claim: process failure never causes another grant. Manual reconciliation
    // is required after a crash between this claim and recording the result.
    if (!await this.redis.set(terminalKey, "grant:" + proof, { nx: true, ex: RETENTION })) {
      return { state: await this.redis.get(terminalKey) === "cancelled" ? "unavailable" : "pending" };
    }
    if (this.now() > challenge.expires) return { state: "unavailable" };
    const concessao = await this.emit({ userId, finalidade: challenge.finalidade, alvo: challenge.alvo, verificacao: "hard" });
    if (!await this.redis.set(resultKey, concessao, { nx: true, ex: TTL })) throw new Error("Rewarded result not persisted");
    if (challenge.finalidade === "reproducao") {
      // Reuse the existing title/episode retry window, only after S2S proof.
      // Like the legacy flow, marker failure cannot create another grant.
      try { await this.markPaid({ userId, finalidade: challenge.finalidade, alvo: challenge.alvo }); } catch { /* Fail closed on a later retry. */ }
    }
    await this.metric("grant");
    await this.redis.compareAndDelete(this.scope(challenge), id);
    return { state: "verified", concessao };
  }
}

function persistentRewardStore(): RedisClient {
  // No per-process fallback for callback ACKs, including staging/development.
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) throw new Error("Persistent rewarded storage required");
  return getRedis();
}
