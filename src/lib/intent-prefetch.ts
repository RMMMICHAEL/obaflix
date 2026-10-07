/**
 * Fase Velocidade 1B — prefetch por intenção.
 *
 * Lógica pura (sem React, sem DOM) para decidir QUANDO vale a pena preparar a
 * navegação de um card. Fica separada do hook de propósito: é o que o Node test
 * runner consegue exercitar direto, sem jsdom.
 */

/**
 * Janela de intenção. Acima de ~150ms o ponteiro já "pousou" no card em vez de
 * só atravessá-lo rumo a outro; abaixo de ~200ms ainda antecede o clique. 180ms
 * fica no meio dessa faixa — rápido o bastante para a navegação parecer pronta,
 * tarde o bastante para não disparar em cada card que o mouse cruza.
 */
export const INTENT_PREFETCH_DELAY_MS = 180;

/** Subconjunto de NetworkInformation que usamos — e que nem todo browser expõe. */
export interface NetworkInfo {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * Decide se um prefetch por intenção deve prosseguir.
 *
 * Sem informação de conexão (a maioria dos browsers desktop não expõe a API)
 * seguimos em frente: o prefetch por intenção já é contido por natureza. Mas
 * respeitamos dois sinais explícitos de conexão limitada quando existem:
 * `saveData` (o usuário pediu para economizar dados) e `effectiveType` 2g.
 */
export function shouldPrefetchOnIntent(connection: NetworkInfo | undefined | null): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  const et = connection.effectiveType ?? "";
  if (et === "2g" || et === "slow-2g") return false;
  return true;
}

/** Lê navigator.connection de forma defensiva (SSR e browsers sem a API). */
export function readConnection(): NetworkInfo | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as Navigator & {
    connection?: NetworkInfo;
    mozConnection?: NetworkInfo;
    webkitConnection?: NetworkInfo;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? undefined;
}
