"use client";

import { useEffect } from "react";
import {
  cliqueElegivel,
  criarContadorDeCliques,
  lerRespostaDoClique,
  type FrequenciaDoClique,
} from "@/lib/ads/cliqueDesktop";

/**
 * Anúncio por clique do aplicativo Windows (Direct Link). Não renderiza nada.
 * Ver `src/lib/ads/cliqueDesktop.ts`.
 *
 * ## Portas
 *
 *  1. **cliente** — `obaflixDesktop.isDesktop === true` e ponte com
 *     `openClickAd`. Navegador comum e Android param aqui, sem fetch e sem
 *     listener;
 *  2. **servidor** — `/api/ads/click-desktop` (flag, direito da conta,
 *     frequência). Decisão vale 120 s; vencida, o clique não abre nada e a
 *     decisão é renovada em segundo plano;
 *  3. **clique** — só clique real (`isTrusted`), botão principal, fora de
 *     player, campos, controles, diálogos e links que saem do app;
 *  4. **processo principal** — frame principal do app, gesto real recente
 *     (consumido), cooldown mínimo próprio, URL fixa dele.
 *
 * ## O clique do usuário não é tocado
 *
 * O listener é passivo, em captura no `document`: não chama `preventDefault`
 * nem `stopPropagation`, não cobre nada e não cria elemento. O clique chega ao
 * Obaflix exatamente como chegaria sem ele.
 */

const VALIDADE_MS = 120_000;

type PonteDoClique = { isDesktop?: unknown; platform?: unknown; openClickAd?: () => Promise<{ opened?: unknown }> };

function ponteDoApp(): PonteDoClique | null {
  const ponte = (window as unknown as { obaflixDesktop?: PonteDoClique }).obaflixDesktop;
  if (ponte?.isDesktop !== true || ponte.platform === "android") return null;
  return typeof ponte.openClickAd === "function" ? ponte : null;
}

function emTelaCheia(): boolean {
  if (document.fullscreenElement) return true;
  if (window.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  return Math.abs(window.innerWidth - screen.width) <= 1 && Math.abs(window.innerHeight - screen.height) <= 1;
}

export function CliqueDesktop() {
  useEffect(() => {
    const ponte = ponteDoApp();
    if (!ponte) return;

    let vivo = true;
    let frequencia: FrequenciaDoClique | null = null;
    let decididoEm = 0;
    let perguntando = false;
    let contador: ReturnType<typeof criarContadorDeCliques> | null = null;
    let abrindo = false;

    const perguntar = () => {
      if (perguntando) return;
      perguntando = true;
      fetch("/api/ads/click-desktop", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((corpo) => {
          perguntando = false;
          if (!vivo) return;
          const nova = lerRespostaDoClique(corpo);
          decididoEm = Date.now();
          // Frequência mudou (ou o anúncio foi desligado): contador novo.
          if (!nova || !frequencia || nova.intervaloCliques !== frequencia.intervaloCliques || nova.cooldownSeg !== frequencia.cooldownSeg) {
            contador = nova ? criarContadorDeCliques(nova) : null;
          }
          frequencia = nova;
        });
    };
    perguntar();

    const aoClicar = (e: MouseEvent) => {
      if (!frequencia || !contador || abrindo) return;
      const agora = Date.now();
      if (agora - decididoEm > VALIDADE_MS) { perguntar(); return; }
      const elegivel = cliqueElegivel({
        confiavel: e.isTrusted,
        botao: e.button,
        alvo: e.target instanceof Element ? e.target : null,
        pathname: location.pathname,
        telaCheia: emTelaCheia(),
        origemDoApp: location.origin,
      });
      if (!elegivel || contador.registrar(agora) !== "abrir") return;
      const atual = contador;
      abrindo = true;
      ponte.openClickAd!()
        .then((r) => { if (r?.opened === true) atual.confirmarAbertura(Date.now()); })
        .catch(() => {})
        .finally(() => { abrindo = false; });
    };

    document.addEventListener("click", aoClicar, { capture: true, passive: true });
    return () => {
      vivo = false;
      document.removeEventListener("click", aoClicar, { capture: true });
    };
  }, []);

  return null;
}
