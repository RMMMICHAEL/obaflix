import crypto from "crypto";

/**
 * Prova de que o DONO de uma conta com senha autorizou vincular um Google a ela: emitida só depois de confirmar a senha
 * atual (`/api/auth/google-link`), assinada, presa ao `userId`, válida por 5 minutos e de uso único. É o que impede o
 * pré-sequestro: igualdade de e-mail sozinha nunca vincula uma conta que tem senha.
 */
export const COOKIE_VINCULO_GOOGLE = "obaflix_google_link";
export const TTL_VINCULO_GOOGLE_SEG = 300;

type Payload = { v: 1; aud: "obaflix-google-link"; uid: string; jti: string; exp: number };

const assinatura = (corpo: string, segredo: string) => crypto.createHmac("sha256", segredo).update(corpo).digest("base64url");

export function criarIntencaoVinculo(userId: string, segredo: string, agoraMs = Date.now()): string {
  if (!segredo || segredo.length < 32) throw new Error("segredo_invalido");
  if (!userId || userId.length > 128) throw new Error("usuario_invalido");
  const payload: Payload = {
    v: 1, aud: "obaflix-google-link", uid: userId, jti: crypto.randomBytes(16).toString("base64url"),
    exp: Math.floor(agoraMs / 1000) + TTL_VINCULO_GOOGLE_SEG,
  };
  const corpo = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${corpo}.${assinatura(corpo, segredo)}`;
}

export function lerIntencaoVinculo(token: string, segredo: string, agoraMs = Date.now()): { uid: string; jti: string } | null {
  try {
    if (!segredo || segredo.length < 32 || typeof token !== "string" || token.length > 1024) return null;
    const [corpo, assin, resto] = token.split(".");
    if (!corpo || !assin || resto !== undefined) return null;
    const esperado = assinatura(corpo, segredo);
    if (assin.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(assin), Buffer.from(esperado))) return null;
    const p = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")) as Payload;
    if (p?.v !== 1 || p.aud !== "obaflix-google-link" || typeof p.uid !== "string" || !p.uid || typeof p.jti !== "string") return null;
    if (!Number.isInteger(p.exp) || p.exp < Math.floor(agoraMs / 1000)) return null;
    return { uid: p.uid, jti: p.jti };
  } catch {
    return null;
  }
}

type RedisNx = { set(key: string, value: string, opts: { ex: number; nx: boolean }): Promise<"OK" | null> };

/** Uso único (SET NX). Falha fechada: sem Redis não há vínculo. */
export async function consumirIntencaoVinculo(redis: RedisNx, jti: string): Promise<boolean> {
  try {
    return (await redis.set(`googlelink:${jti}`, "1", { ex: TTL_VINCULO_GOOGLE_SEG + 60, nx: true })) === "OK";
  } catch {
    return false;
  }
}
