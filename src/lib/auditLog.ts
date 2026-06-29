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
  | "auth_failure";

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
