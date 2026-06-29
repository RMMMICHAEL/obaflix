/**
 * Métricas de segurança e reprodução via Redis.
 *
 * Cada métrica é um contador INCR com chave hourly (ex: metrics:2026-06-29T14:stream_started)
 * e TTL de 30 dias. Contadores diários são derivados agregando as 24 janelas horárias.
 *
 * Contadores disponíveis:
 *   stream_started        — reproduções iniciadas com sucesso
 *   stream_started:{tipo} — por tipo de player (hls, mp4, iframe)
 *   play_token_issued     — play tokens emitidos
 *   play_token_rejected   — play tokens rejeitados
 *   stream_rejected       — stream tokens rejeitados
 *   segment_rejected      — segmentos HLS com HMAC inválido
 *   auth_failure          — requisições sem sessão válida
 *   ip_blocked            — IPs bloqueados por abuso
 *   rate_limited          — usuários atingindo rate limit
 *   origin_rejected       — requisições de origem externa rejeitadas
 *   concurrent_limit      — limite de streams simultâneos atingido
 */

import { getRedis } from "./redis";

const TTL_SEC = 30 * 24 * 3600; // 30 dias

function hourKey(metric: string): string {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13); // "2026-06-29T14"
  return `metrics:${hour}:${metric}`;
}

function dayKey(metric: string, date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return `metrics:${d}:${metric}`;
}

export async function incr(metric: string): Promise<void> {
  const redis = getRedis();
  const key = hourKey(metric);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, TTL_SEC);
}

/** Registra uma métrica de player com detalhamento por tipo */
export async function incrStream(tipo: "hls" | "mp4" | "iframe"): Promise<void> {
  await Promise.all([incr("stream_started"), incr(`stream_started:${tipo}`)]);
}

/** Agrega contadores das últimas N horas */
export async function getHourly(metric: string, hours = 24): Promise<{ hour: string; count: number }[]> {
  const redis = getRedis();
  const result: { hour: string; count: number }[] = [];
  const now = Date.now();
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now - i * 3600 * 1000);
    const hour = d.toISOString().slice(0, 13);
    const key = `metrics:${hour}:${metric}`;
    const val = await redis.get(key);
    result.push({ hour, count: val ? parseInt(val, 10) : 0 });
  }
  return result;
}

/** Soma total das últimas N horas */
export async function getTotal(metric: string, hours = 24): Promise<number> {
  const rows = await getHourly(metric, hours);
  return rows.reduce((s, r) => s + r.count, 0);
}

/** Snapshot completo das últimas N horas para o painel admin */
export async function getSnapshot(hours = 24): Promise<Record<string, number>> {
  const metrics = [
    "stream_started",
    "stream_started:hls",
    "stream_started:mp4",
    "stream_started:iframe",
    "play_token_issued",
    "play_token_rejected",
    "stream_rejected",
    "segment_rejected",
    "auth_failure",
    "ip_blocked",
    "rate_limited",
    "origin_rejected",
    "concurrent_limit",
  ];

  const totals = await Promise.all(metrics.map(m => getTotal(m, hours)));
  return Object.fromEntries(metrics.map((m, i) => [m, totals[i]]));
}

/** Série horária para gráfico (últimas 48h por padrão) */
export async function getSeries(
  metric: string,
  hours = 48,
): Promise<{ hour: string; count: number }[]> {
  return getHourly(metric, hours);
}
