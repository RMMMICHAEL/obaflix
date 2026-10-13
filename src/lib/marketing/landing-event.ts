/**
 * Validação server-side dos eventos da landing. Pura: sem DOM, sem Prisma, sem
 * rede — recebe o corpo cru e devolve ou um evento normalizado, ou um status de
 * recusa. Enums fechados; os UTMs são sanitizados de novo aqui (nunca confiar no
 * cliente). Nada deste arquivo monta SQL nem toca banco.
 *
 * Os eventos são operacionais: `android_download_click` é um CLIQUE no botão,
 * não uma instalação do APK. O vocabulário "instalação/install" não existe de
 * propósito.
 */

import { sanitizeUtm, type Utm } from "./utm";

export const LANDING_EVENTS = ["landing_view", "open_external_browser_click", "android_download_click"] as const;
export type LandingEventName = (typeof LANDING_EVENTS)[number];

export const LANDING_CONTEXTS = ["in_app", "browser"] as const;
export type LandingContext = (typeof LANDING_CONTEXTS)[number];

export const LANDING_PLACEMENTS = ["page", "hero", "final", "bar"] as const;
export type LandingPlacement = (typeof LANDING_PLACEMENTS)[number];

const CLICK_PLACEMENTS: readonly LandingPlacement[] = ["hero", "final", "bar"];

export type NormalizedLandingEvent = {
  event: LandingEventName;
  context: LandingContext;
  placement: LandingPlacement;
} & Utm;

export type LandingEventResult =
  | { ok: true; value: NormalizedLandingEvent }
  | { ok: false; status: 400 };

const fail: LandingEventResult = { ok: false, status: 400 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Regras do funil, fechadas:
 *   - `landing_view` acontece na página → placement `page`, contexto in_app|browser;
 *   - `open_external_browser_click` só no WebView interno → contexto in_app;
 *   - `android_download_click` só no navegador normal → contexto browser;
 *   - cliques só em placement hero|final|bar.
 * Qualquer desvio é 400 — não adivinhamos nem coagimos valor inválido.
 */
export function validateLandingEvent(raw: unknown): LandingEventResult {
  if (!isObject(raw)) return fail;

  const event = raw.event;
  const context = raw.context;
  const placement = raw.placement;
  if (!LANDING_EVENTS.includes(event as LandingEventName)) return fail;
  if (!LANDING_CONTEXTS.includes(context as LandingContext)) return fail;
  if (!LANDING_PLACEMENTS.includes(placement as LandingPlacement)) return fail;

  const ev = event as LandingEventName;
  const ctx = context as LandingContext;
  const place = placement as LandingPlacement;

  if (ev === "landing_view" && place !== "page") return fail;
  if (ev === "open_external_browser_click" && (ctx !== "in_app" || !CLICK_PLACEMENTS.includes(place))) return fail;
  if (ev === "android_download_click" && (ctx !== "browser" || !CLICK_PLACEMENTS.includes(place))) return fail;

  const attribution = isObject(raw.attribution) ? raw.attribution : undefined;
  const utm = sanitizeUtm(attribution as Partial<Record<keyof Utm, unknown>> | undefined);

  return { ok: true, value: { event: ev, context: ctx, placement: place, ...utm } };
}
