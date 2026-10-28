import crypto from "node:crypto";

const VIDA_MS = 2 * 60 * 60 * 1000;
const ASSUNTO = "obaflix:cortes:pedido-visitante:v1";

/** Capacitação curta, vinculada a UM pedido; jamais em URL, logs ou storage. */
export function emitirConsultaVisitante(pedidoId: string, secret = process.env.NEXTAUTH_SECRET, agora = Date.now()): string | null {
  if (!secret || secret.length < 32) return null;
  const instante = String(agora);
  const assinatura = crypto.createHmac("sha256", secret).update(`${ASSUNTO}:${pedidoId}:${instante}`).digest("base64url");
  return `${instante}.${assinatura}`;
}

export function consultaVisitanteValida(pedidoId: string, token: unknown, secret = process.env.NEXTAUTH_SECRET, agora = Date.now()): boolean {
  if (!secret || secret.length < 32 || typeof token !== "string" || !/^\d{13}\.[\w-]{43}$/.test(token)) return false;
  const instante = Number(token.split(".")[0]);
  if (!Number.isSafeInteger(instante) || instante > agora + 60_000 || agora - instante > VIDA_MS) return false;
  const esperado = emitirConsultaVisitante(pedidoId, secret, instante);
  if (!esperado) return false;
  const a = Buffer.from(esperado), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
