/**
 * Auditoria + métricas da camada de reprodução.
 *
 * audit() emite um log JSON estruturado (capturado pelo Vercel Logs)
 * e incrementa o contador Redis correspondente em uma única chamada.
 * Os logs são indexáveis por ferramentas como Datadog, Axiom ou Vercel Log Drains.
 */

import { incr, incrStream } from "./metrics";

export type AuditEvent =
  | "play_token_issued"
  | "play_token_rejected"
  | "stream_started"
  | "stream_rejected"
  | "segment_rejected"
  | "ip_blocked"
  | "concurrent_limit"
  | "rate_limited"
  | "origin_rejected"
  | "auth_failure"
  // Pareamento de TV. Eventos próprios em vez de reaproveitar os de player:
  // reaproveitar deixaria o contador de "ip_blocked" subir por uma revogação
  // de aparelho, que não tem nada a ver, e a métrica perderia sentido.
  | "tv_paired"
  | "tv_device_revoked"
  // Enforcement comercial, pelo mesmo motivo dos eventos de TV acima: somar uma
  // recusa por plano ao contador de `stream_rejected`, que mede problema de
  // token e de extração, faria as duas métricas perderem sentido justamente
  // quando a monetização for ligada e o volume mudar.
  //
  // Os dois são separados de propósito: `playback_negado` é resposta sobre a
  // conta, e crescer é esperado; `entitlements_indisponiveis` é incidente de
  // infraestrutura, e crescer é alarme.
  | "playback_negado"
  | "entitlements_indisponiveis";

interface AuditMeta {
  userId?: string;
  ip?: string;
  ua?: string;
  detail?: string;
}

export function audit(event: AuditEvent, meta: AuditMeta): void {
  // Log estruturado (síncrono — sem await para não bloquear a resposta)
  console.log(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      userId: meta.userId,
      ip: meta.ip,
      ua: meta.ua ? meta.ua.slice(0, 120) : undefined,
      detail: meta.detail,
    }),
  );

  // Contador Redis (fire-and-forget — falha silenciosa para não impactar o player)
  const tipo = meta.detail?.match(/tipo:\s*(hls|mp4|iframe)/)?.[1] as "hls" | "mp4" | "iframe" | undefined;

  (event === "stream_started" && tipo
    ? incrStream(tipo)
    : incr(event === "auth_failure" ? "auth_failure" : event)
  ).catch(() => {});
}
