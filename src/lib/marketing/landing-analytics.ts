/**
 * Envio first-party dos eventos da landing, do cliente para
 * `POST /api/marketing/landing-event`.
 *
 * Regra de ouro: métrica nunca bloqueia UX. Tudo aqui é fire-and-forget e
 * engolido em caso de erro. Preferimos `navigator.sendBeacon` (sobrevive à
 * navegação/fechamento da aba); se indisponível, caímos em `fetch(keepalive)`.
 * Nunca esperamos a resposta antes de abrir o navegador externo ou seguir para
 * `/download/android`.
 *
 * Não cria cookie, localStorage, sessionStorage nem qualquer identificador. O
 * corpo leva só o evento, o contexto, o placement e os UTMs (sanitizados).
 */

import type { LandingEventName, LandingContext, LandingPlacement } from "./landing-event";
import type { Utm } from "./utm";

const ENDPOINT = "/api/marketing/landing-event";

export type LandingEventPayload = {
  event: LandingEventName;
  context: LandingContext;
  placement: LandingPlacement;
  attribution: Utm;
};

export function sendLandingEvent(payload: LandingEventPayload): void {
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    if (typeof fetch === "function") {
      void fetch(ENDPOINT, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {});
    }
  } catch {
    // Fail open: nenhuma falha de métrica pode interromper o download.
  }
}
