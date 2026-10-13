import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { callbackUnit, type AdmobUnits, type Distribution, type SsvEvent } from "./admobSsv";

export interface AdmobSql {
  query<T>(sql: Prisma.Sql): Promise<T[]>;
  execute(sql: Prisma.Sql): Promise<number>;
}
export interface AdmobDatabase extends AdmobSql { transaction<T>(work: (tx: AdmobSql) => Promise<T>): Promise<T> }
export const postgresAdmob: AdmobDatabase = {
  query: sql => prisma.$queryRaw(sql), execute: sql => prisma.$executeRaw(sql),
  transaction: work => prisma.$transaction(tx => work({ query: sql => tx.$queryRaw(sql), execute: sql => tx.$executeRaw(sql) }), {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5000, maxWait: 2000,
  }),
};
interface Challenge {
  nonce: string; account_id: string; distribution: Distribution; purpose: string; target: unknown;
  ad_unit: string; reward_amount: string; reward_item: string; created_at: Date; expires_at: Date;
  state: "pending" | "verified" | "cancelled";
}
export interface OptionalScope { accountId: string; distribution: Distribution; target: { tipo: "filme" | "serie"; conteudoId: string; temporada?: number; episodio?: number } }

/** Durable receipt ledger only: no legacy concessao, paid marker or playback pass. */
export class AdmobRewards {
  constructor(private readonly db: AdmobDatabase = postgresAdmob, private readonly now = Date.now) {}
  async openAuthorized(scope: OptionalScope, units: AdmobUnits): Promise<{ nonce: string; unitId: string; expiresAt: number }> {
    if (!scope.accountId || !["play", "direct"].includes(scope.distribution) || !scope.target.conteudoId || !["filme", "serie"].includes(scope.target.tipo)) throw new Error("Invalid optional scope");
    const nonce = randomBytes(32).toString("hex");
    const created = this.now();
    const expiresAt = created + 10 * 60_000;
    const unitId = units[scope.distribution];
    await this.db.transaction(async tx => {
      // Cross-instance serialization per account/distribution; parameterized SQL.
      await tx.query(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope.accountId, scope.distribution])}, 0))::text`);
      const active = await tx.query(Prisma.sql`SELECT nonce FROM ads_private.admob_challenge WHERE account_id=${scope.accountId} AND distribution=${scope.distribution} AND state='pending' AND expires_at>${new Date(created)} LIMIT 1`);
      if (active.length) throw new Error("Optional operation already active");
      const inserted = await tx.execute(Prisma.sql`INSERT INTO ads_private.admob_challenge(nonce, account_id, distribution, purpose, target, ad_unit, reward_amount, reward_item, created_at, expires_at)
        VALUES (${nonce}, ${scope.accountId}, ${scope.distribution}, 'optional_pending_policy', ${JSON.stringify(scope.target)}::jsonb, ${callbackUnit(unitId)}, ${units.rewardAmount}, ${units.rewardItem}, ${new Date(created)}, ${new Date(expiresAt)})`);
      if (inserted !== 1) throw new Error("Challenge not persisted");
    });
    return { nonce, unitId, expiresAt };
  }
  async receive(event: SsvEvent): Promise<"verified" | "rejected" | "duplicate"> {
    return this.db.transaction(async tx => {
      // Serialize same transaction before taking challenge row lock. No two
      // challenges can claim the same event, even on different server instances.
      await tx.query(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"admob-event:" + event.transactionId}, 0))::text`);
      const prior = await tx.query<{ digest: string; nonce: string }>(Prisma.sql`SELECT digest, nonce FROM ads_private.admob_ssv_inbox WHERE transaction_id=${event.transactionId}`);
      if (prior.length) {
        if (prior[0].digest !== event.digest || prior[0].nonce !== event.nonce) throw new Error("SSV transaction conflict");
        return "duplicate";
      }
      const rows = await tx.query<Challenge>(Prisma.sql`SELECT * FROM ads_private.admob_challenge WHERE nonce=${event.nonce} FOR UPDATE`);
      const challenge = rows[0];
      // A delayed delivery is valid only when the SIGNED reward time was inside
      // the original challenge window. Arrival time is never completion proof.
      const valid = !!challenge && challenge.state === "pending" && challenge.purpose === "optional_pending_policy" &&
        challenge.ad_unit === event.unit && challenge.reward_amount === event.amount && challenge.reward_item === event.item &&
        event.userId === challenge.nonce && event.timestamp >= challenge.created_at.getTime() && event.timestamp <= challenge.expires_at.getTime();
      const disposition = valid ? "verified" : "rejected";
      const persisted = await tx.execute(Prisma.sql`INSERT INTO ads_private.admob_ssv_inbox(transaction_id, nonce, digest, ad_unit, rewarded_at, received_at, disposition)
        VALUES (${event.transactionId}, ${event.nonce}, ${event.digest}, ${event.unit}, ${new Date(event.timestamp)}, ${new Date(this.now())}, ${disposition})`);
      if (persisted !== 1) throw new Error("Receipt not persisted");
      if (valid && await tx.execute(Prisma.sql`UPDATE ads_private.admob_challenge SET state='verified', transaction_id=${event.transactionId}, verified_at=${new Date(this.now())} WHERE nonce=${event.nonce} AND state='pending'`) !== 1) throw new Error("Challenge state not persisted");
      return disposition;
    }); // ACK only after COMMIT; exceptions/rollback must remain non-200.
  }
  async status(nonce: string, accountId: string, distribution: Distribution, units: AdmobUnits, cancel = false) {
    if (!/^[a-f0-9]{64}$/.test(nonce)) return { state: "unavailable", eligibleForAd: false, benefitGranted: false };
    return this.db.transaction(async tx => {
      const rows = await tx.query<Challenge>(Prisma.sql`SELECT * FROM ads_private.admob_challenge WHERE nonce=${nonce} AND account_id=${accountId} AND distribution=${distribution} FOR UPDATE`);
      const challenge = rows[0];
      if (!challenge) return { state: "unavailable", eligibleForAd: false, benefitGranted: false };
      if (cancel && challenge.state === "pending") {
        await tx.execute(Prisma.sql`UPDATE ads_private.admob_challenge SET state='cancelled' WHERE nonce=${nonce}`);
        challenge.state = "cancelled";
      }
      const state = challenge.state === "pending" && this.now() > challenge.expires_at.getTime() ? "expired" : challenge.state;
      return { state, eligibleForAd: state === "pending" && challenge.ad_unit === callbackUnit(units[distribution]),
        unitId: units[distribution], benefitGranted: false };
    });
  }
}
