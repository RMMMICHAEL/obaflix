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
  | "entitlements_indisponiveis"
  // Cobrança (Fase 4). Separados dos eventos de player pelo mesmo motivo dos
  // anteriores: somar uma falha de gateway ao contador de `stream_rejected`
  // faria as duas métricas perderem sentido.
  //
  // `billing_order_failed` cobre tanto a recusa comercial (preço inexistente,
  // inativo, incoerente) quanto a falha do provedor. O `detail` distingue, com
  // código interno já sanitizado — nunca a mensagem da Blackcat.
  //
  // **O que nunca entra no `detail` destes dois:** QR, copia-e-cola,
  // `qrCodeBase64`, CPF, telefone, `X-API-Key`, `Authorization`, cookie,
  // `refExterna` ou qualquer parte do payload do provedor. `pedidoId` e o código
  // do motivo bastam para investigar, e `pedidoId` é identificador nosso.
  | "billing_order_created"
  | "billing_order_failed"
  // Funil Cortes: agregados, sem parâmetros pessoais.
  | "cortes_checkout_view"
  | "cortes_checkout_attempt"
  | "cortes_checkout_pix_created"
  // Canais ao vivo. Eventos próprios pelo mesmo motivo de todos os anteriores:
  // `canal_resolucao_falhou` mede a saúde do provider e `canal_negado` mede
  // recusa comercial. Somados a `stream_rejected`, que mede token, os três
  // perderiam sentido — e é justamente `canal_resolucao_falhou` subindo sozinho
  // que diz "o provider mudou", o alarme mais útil desta fase.
  //
  // **O que nunca entra no `detail` destes:** URL de mídia, host de CDN,
  // `providerChannelId`, a página do player, ou o `sessionId` inteiro. O id do
  // canal e o motivo bastam para investigar, e o id do canal é nosso.
  | "canal_negado"
  | "canal_sessao_criada"
  | "canal_resolucao_falhou"
  | "billing_webhook_received"
  | "billing_payment_confirmed"
  | "billing_payment_review"
  | "billing_payment_refunded"
  | "billing_reconcile_failed"
  | "billing_entitlements_invalidation_failed"
  // Revisão manual: ação administrativa executada ou recusada, e compra
  // bloqueada por caso pendente. `detail` leva só códigos internos e ids.
  | "billing_review_action"
  | "billing_review_action_refused"
  // Consulta autoritativa ao provedor não trouxe status na revisão. `detail`
  // leva só a classificação segura da falha e ids permitidos — nunca
  // transactionId completo, chave, corpo do provedor ou dado do cliente.
  | "billing_review_provider_failed"
  // Resposta 2xx da consulta de status que o parser recusou: diagnóstico
  // ESTRUTURAL apenas — `detail` leva só flags de presença/tipo (e o typeof de
  // amount, nunca o valor). Nunca transactionId real, status literal, amount,
  // paidAt, corpo cru, headers, chave ou dado do cliente.
  | "billing_confirmation_shape"
  | "billing_order_blocked_review"
  // Exclusão de conta (autosserviço). Só eventos técnicos e ids internos: nunca
  // e-mail, nome, telefone, documento, cookie, token ou qualquer PII. `detail`
  // leva apenas o código da recusa (`sem_sessao`, `admin_nao_pode_excluir`,
  // `confirmacao_invalida`, `limite_indisponivel`, `falha_na_transacao`), nunca
  // o valor que falhou.
  | "account_delete_requested"
  | "account_delete_completed"
  | "account_delete_rejected"
  | "email_sent"
  | "email_failed"
  | "meta_capi_purchase_sent"
  | "meta_capi_purchase_failed"
  | "meta_capi_teste"
  | "account_activated"
  | "account_activation_rejected"
  // Cortes AI. `detail` leva só códigos, id do conteúdo, contagens e tokens —
  // nunca o pedido do usuário, a legenda, a chave ou o corpo do provedor.
  | "cortes_ai_negado"
  | "cortes_ai_analise"
  | "cortes_ai_falhou";

interface AuditMeta {
  userId?: string | null;
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
