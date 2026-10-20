/**
 * UTM da landing de download: sanitização, leitura e handoff seguro.
 *
 * Aceitamos exclusivamente quatro parâmetros — `utm_source`, `utm_medium`,
 * `utm_campaign`, `utm_content`. Qualquer outro (`ttclid`, `gclid`, `fbclid`,
 * `evil=…`, texto livre) é ignorado e nunca é preservado nem armazenado.
 *
 * O handoff "Abrir no navegador" parte SEMPRE da constante `PUBLIC_LANDING_URL`
 * (host fixo `obaflixbr.com`, scheme https). Nenhum pedaço do destino vem do
 * Host da request, de preview `.vercel.app` ou de valor cru do usuário: os UTMs
 * entram já sanitizados, com charset `[a-z0-9_-]`, então não há como injetar
 * query, `#`, `;` ou outro host — open redirect continua impossível.
 */

import { PUBLIC_LANDING_URL } from "@/config/public-download";

export const UTM_KEYS = ["source", "medium", "campaign", "content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Record<UtmKey, string>;

/** Valor neutro quando ausente ou inválido. Nunca vira texto livre no banco. */
export const UTM_NONE = "none";

const UTM_ALLOWED = /^[a-z0-9_-]+$/;
const UTM_MAX = 64;

/**
 * Normaliza um valor único: trim, lowercase, ≤64, charset `[a-z0-9_-]`.
 * Fora disso → "none". Recusa URL, e-mail, espaço, HTML e caractere de controle
 * por consequência do charset — não há exceção.
 */
export function sanitizeUtmValue(raw: unknown): string {
  if (typeof raw !== "string") return UTM_NONE;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > UTM_MAX || !UTM_ALLOWED.test(value)) return UTM_NONE;
  return value;
}

/** Objeto `{source,medium,campaign,content}` cru → UTM sanitizado e fechado. */
export function sanitizeUtm(input: Partial<Record<UtmKey, unknown>> | null | undefined): Utm {
  const out = {} as Utm;
  for (const key of UTM_KEYS) out[key] = sanitizeUtmValue(input?.[key]);
  return out;
}

/** Lê os quatro `utm_*` de uma query (string ou URLSearchParams) e sanitiza. */
export function parseUtm(search: string | URLSearchParams): Utm {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return sanitizeUtm({
    source: params.get("utm_source"),
    medium: params.get("utm_medium"),
    campaign: params.get("utm_campaign"),
    content: params.get("utm_content"),
  });
}

/** `true` se há ao menos um UTM válido (diferente de "none"). */
export function hasUtm(utm: Utm): boolean {
  return UTM_KEYS.some((key) => utm[key] !== UTM_NONE);
}

/**
 * URL externa canônica com apenas os UTMs válidos preservados. Base fixa; chaves
 * "none" são omitidas. Ordem estável: source, medium, campaign, content.
 */
export function buildLandingExternalUrl(utm: Utm): string {
  const url = new URL(PUBLIC_LANDING_URL);
  for (const key of UTM_KEYS) {
    if (utm[key] !== UTM_NONE) url.searchParams.set(`utm_${key}`, utm[key]);
  }
  return url.toString();
}

/**
 * Intent URI de Android para o destino externo, carregando os UTMs válidos.
 * Deriva da URL externa (já segura) e só troca o scheme por `intent://`, sem
 * `package=` — deixa o Android escolher o navegador (Chrome, Samsung, Firefox…).
 */
export function buildLandingIntentUrl(utm: Utm): string {
  const url = new URL(buildLandingExternalUrl(utm));
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;action=android.intent.action.VIEW;end`;
}
