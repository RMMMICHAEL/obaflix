/**
 * Auditoria de eventos de segurança da camada de reprodução.
 *
 * Em produção, os logs são capturados pelo Vercel Logs / observabilidade padrão.
 * O formato JSON estruturado facilita filtragem e alertas externos (ex: Datadog, Axiom).
 *
 * Eventos registrados:
 *   play_token_issued   — play token emitido com sucesso
 *   play_token_rejected — play token inválido, expirado ou IP mismatch fatal
 *   stream_started      — stream token emitido, reprodução iniciada
 *   stream_rejected     — stream token inválido, expirado ou já consumido
 *   segment_rejected    — assinatura HMAC de segmento inválida
 *   ip_blocked          — IP bloqueado por abuso
 *   concurrent_limit    — limite de reproduções simultâneas atingido
 *   rate_limited        — rate limit por userId atingido
 *   origin_rejected     — origem ou referer externos rejeitados
 */

export type AuditEvent =
  | "play_token_issued"
  | "play_token_rejected"
  | "stream_started"
  | "stream_rejected"
  | "segment_rejected"
  | "ip_blocked"
  | "concurrent_limit"
  | "rate_limited"
  | "origin_rejected";

interface AuditPayload {
  event: AuditEvent;
  userId?: string;
  ip?: string;
  ua?: string;
  detail?: string;
  ts: string;
}

export function audit(event: AuditEvent, meta: Omit<AuditPayload, "event" | "ts">): void {
  const payload: AuditPayload = {
    event,
    ts: new Date().toISOString(),
    ...meta,
    // Trunca UA para não poluir os logs
    ua: meta.ua ? meta.ua.slice(0, 120) : undefined,
  };
  // console.log é capturado pelo Vercel Logs com timestamp automático
  console.log(JSON.stringify(payload));
}
