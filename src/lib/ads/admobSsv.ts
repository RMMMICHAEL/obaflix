import { createHash, createPublicKey, verify } from "node:crypto";

export type Distribution = "play" | "direct";
export interface AdmobUnits { play: string; direct: string; rewardAmount: string; rewardItem: string }
export interface SsvEvent { nonce: string; userId: string; transactionId: string; unit: string; timestamp: number; amount: string; item: string; digest: string }
export const ADMOB_OPTIONAL_BENEFIT_APPROVED = false;
export function unitsFromEnv(env: Record<string, string | undefined> = process.env): AdmobUnits | null {
  const play = env.ADMOB_REWARDED_PLAY_STANDARD_ID ?? "";
  const direct = env.ADMOB_REWARDED_DIRECT_STANDARD_ID ?? "";
  const rewardAmount = env.ADMOB_REWARD_AMOUNT ?? "";
  const rewardItem = env.ADMOB_REWARD_ITEM ?? "";
  if (!/^ca-app-pub-\d+\/\d+$/.test(play) || !/^ca-app-pub-\d+\/\d+$/.test(direct) ||
      play === direct || callbackUnit(play) === callbackUnit(direct) || rewardAmount !== "1" || !/^[a-zA-Z0-9_-]{1,64}$/.test(rewardItem)) return null;
  return { play, direct, rewardAmount, rewardItem };
}
export function callbackUnit(fullId: string): string { return fullId.slice(fullId.lastIndexOf("/") + 1); }
export function optionalChallengesEnabled(): boolean {
  return ADMOB_OPTIONAL_BENEFIT_APPROVED && process.env.ADMOB_OPTIONAL_REWARDED_ENABLED === "true" && !!unitsFromEnv();
}
export class InvalidSsv extends Error {}
export class SsvKeysUnavailable extends Error {}
const KEY_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
/** Fixed trusted origin, bounded cache/refresh and no key supplied by the callback. */
export class GoogleSsvKeys {
  private keys = new Map<string, string>();
  private expires = 0;
  private nextRefresh = 0;
  private pending: Promise<void> | null = null;
  constructor(private readonly request: typeof fetch = fetch, private readonly now = Date.now) {}
  async get(id: string): Promise<string> {
    if (this.now() < this.expires && this.keys.has(id)) return this.keys.get(id)!;
    if (this.now() >= this.nextRefresh) {
      if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = null; });
      await this.pending;
    } else if (this.pending) await this.pending;
    if (this.now() >= this.expires || !this.keys.has(id)) throw new SsvKeysUnavailable("No trusted signing key");
    return this.keys.get(id)!;
  }
  private async refresh() {
    this.nextRefresh = this.now() + 60_000;
    try {
      const response = await this.request(KEY_URL, { redirect: "error", signal: AbortSignal.timeout(3000), cache: "no-store" });
      if (!response.ok) throw new Error("Key request failed");
      const raw = await response.text();
      if (raw.length > 65536) throw new Error("Key response too large");
      const input = JSON.parse(raw) as { keys?: Array<{ keyId: number; pem: string }> };
      const keys = new Map<string, string>();
      for (const key of input.keys ?? []) {
        if (!Number.isSafeInteger(key.keyId) || key.keyId < 0 || typeof key.pem !== "string") throw new Error("Invalid key");
        const parsed = createPublicKey(key.pem);
        if (parsed.asymmetricKeyType !== "ec" || !["prime256v1", "secp384r1", "secp521r1"].includes(parsed.asymmetricKeyDetails?.namedCurve ?? "")) throw new Error("Unexpected signing algorithm");
        keys.set(String(key.keyId), key.pem);
      }
      if (keys.size === 0 || keys.size > 16) throw new Error("Invalid key set");
      this.keys = keys; this.expires = this.now() + 23 * 60 * 60_000;
    } catch { throw new SsvKeysUnavailable("Signing keys unavailable"); }
  }
}
export const googleSsvKeys = new GoogleSsvKeys();

/** Verify the original escaped bytes, not URLSearchParams.toString() or decoded/reordered data. */
export async function verifySsv(rawQuery: string, keys: Pick<GoogleSsvKeys, "get">, units: AdmobUnits, now = Date.now()): Promise<SsvEvent> {
  if (rawQuery.length > 8192 || /[\r\n#]/.test(rawQuery)) throw new InvalidSsv("Invalid query");
  const match = /^(.*)&signature=([A-Za-z0-9_-]+={0,2})&key_id=(\d+)$/.exec(rawQuery);
  if (!match || !match[1]) throw new InvalidSsv("Invalid signature framing");
  const params = new URLSearchParams(rawQuery);
  const required = ["ad_network", "ad_unit", "custom_data", "reward_amount", "reward_item", "timestamp", "transaction_id", "user_id", "signature", "key_id"];
  if (required.some(key => params.getAll(key).length !== 1) || [...params.keys()].some(key => !required.includes(key))) throw new InvalidSsv("Invalid signed fields");
  const publicKey = await keys.get(match[3]);
  if (!verify("sha256", Buffer.from(match[1], "utf8"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(match[2], "base64url"))) throw new InvalidSsv("Invalid signature");
  const nonce = params.get("custom_data")!;
  const userId = params.get("user_id")!;
  const transactionId = params.get("transaction_id")!;
  const timestampText = params.get("timestamp")!;
  const encodedTime = Number(timestampText);
  // The guide labels milliseconds but includes a 16-digit microsecond example.
  // Accept these two explicit encodings only; verify unchanged bytes first.
  const timestamp = timestampText.length === 16 ? Math.floor(encodedTime / 1000) : encodedTime;
  const unit = params.get("ad_unit")!;
  if (!/^[a-f0-9]{64}$/.test(nonce) || userId !== nonce || !/^[a-fA-F0-9]{1,128}$/.test(transactionId) ||
      !/^(\d{13}|\d{16})$/.test(timestampText) || !Number.isSafeInteger(encodedTime) || timestamp > now + 60_000 || now - timestamp > 24 * 60 * 60_000 ||
      ![callbackUnit(units.play), callbackUnit(units.direct)].includes(unit) ||
      params.get("reward_amount") !== units.rewardAmount || params.get("reward_item") !== units.rewardItem) throw new InvalidSsv("Invalid reward scope");
  return { nonce, userId, transactionId, unit, timestamp, amount: params.get("reward_amount")!, item: params.get("reward_item")!,
    digest: createHash("sha256").update(match[1]).digest("hex") };
}
