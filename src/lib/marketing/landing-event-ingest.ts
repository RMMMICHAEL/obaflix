/**
 * Lógica de ingestão de `POST /api/marketing/landing-event`, fora do arquivo de
 * rota para poder ser testada (o Next só deixa `route.ts` exportar handlers
 * conhecidos). Público, mas estreito: só POST, corpo ≤ ~2 KB, preferência por
 * same-origin, enums fechados e UTMs re-sanitizados. Responde 204 e nunca
 * devolve dado do banco. Nada do corpo monta SQL ou URL; nenhum identificador
 * de pessoa é lido ou persistido.
 */

import type { NextRequest } from "next/server";
import { headerMatchesHost } from "@/lib/requestSecurity";
import { validateLandingEvent, type NormalizedLandingEvent } from "./landing-event";
import { incrementLandingMetric } from "./landing-metrics";

const MAX_BYTES = 2048;

/** Aceita same-origin; recusa cross-site explícito. Não usa os headers p/ URL. */
export function sameOriginRejection(req: NextRequest): Response | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return new Response(null, { status: 403 });
  }
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    return new Response(null, { status: 403 });
  }
  return null;
}

export type LandingEventDeps = {
  increment?: (value: NormalizedLandingEvent) => Promise<void>;
};

export async function handleLandingEvent(req: NextRequest, deps: LandingEventDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const originGuard = sameOriginRejection(req);
  if (originGuard) return originGuard;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) return new Response(null, { status: 413 });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (text.length > MAX_BYTES) return new Response(null, { status: 413 });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  const parsed = validateLandingEvent(raw);
  if (!parsed.ok) return new Response(null, { status: parsed.status });

  // Fail open: se o banco estiver lento/indisponível, a UX não pode cair.
  try {
    await (deps.increment ?? incrementLandingMetric)(parsed.value);
  } catch {
    /* métrica é best-effort */
  }

  return new Response(null, { status: 204 });
}
