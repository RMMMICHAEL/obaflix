/**
 * Anúncio por clique do aplicativo Windows (Direct Link), puro.
 *
 * ## O que é, e o que não é
 *
 * Não é a zona OnClick/Popunder da Monetag: nenhum script de terceiro roda no
 * app. O app conta os cliques **reais** do usuário na própria interface e, na
 * vez certa, pede ao processo principal do Electron que abra o Direct Link no
 * navegador do sistema. O clique original segue normalmente — o listener é
 * passivo e nunca cancela nada.
 *
 * Caminho completo: listener (`src/components/ads/CliqueDesktop.tsx`) →
 * `window.obaflixDesktop.openClickAd()` (sem parâmetro) → IPC → `main.js`, que
 * exige frame principal do app, gesto real recente (consumido) e abre só a URL
 * fixa dele. A URL do anúncio nunca passa pelo renderer nem por esta API.
 *
 * ## Quem recebe
 *
 * A mesma regra do banner (`decidirBannerDesktop`): só `desktop`, só conta
 * sujeita a anúncio (`exigeAnuncio`), anônimo sim, direito indefinido não —
 * com flag própria, `ANUNCIO_CLICK_DESKTOP_ATIVO`.
 */

import type { Ambiente } from "../../config/site-mode";
import { decidirBannerDesktop, type ContaDoBanner } from "./bannerDesktop";

/** Liga o anúncio por clique. Servidor-only; só a string exata `"true"`. */
export function cliqueDesktopAtivo(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ANUNCIO_CLICK_DESKTOP_ATIVO === "true";
}

export function decidirCliqueDesktop(fatos: {
  ativo: boolean;
  ambiente: Ambiente;
  conta: ContaDoBanner;
}): boolean {
  return decidirBannerDesktop(fatos);
}

// ── Frequência ────────────────────────────────────────────────────────────────

export type FrequenciaDoClique = { intervaloCliques: number; cooldownSeg: number };

export const FREQUENCIA_PADRAO: FrequenciaDoClique = { intervaloCliques: 3, cooldownSeg: 120 };

/**
 * Limites aceitos. Fora deles (ou não inteiro) vale o padrão. O piso do
 * cooldown é o mesmo que o `main.js` impõe por conta própria
 * (`COOLDOWN_MINIMO_DO_CLIQUE_MS` em desktop/electron/window-policy.js):
 * configuração nenhuma faz o app abrir anúncio mais de uma vez a cada 30 s.
 */
export const LIMITES_DA_FREQUENCIA = {
  intervaloCliques: { min: 1, max: 100 },
  cooldownSeg: { min: 30, max: 86_400 },
} as const;

function inteiroEntre(bruto: string | undefined, min: number, max: number, padrao: number): number {
  if (typeof bruto !== "string" || !/^\s*\d+\s*$/.test(bruto)) return padrao;
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : padrao;
}

/** Lida do servidor (sem EXE novo): `ANUNCIO_CLICK_DESKTOP_INTERVALO_CLIQUES`, `…_COOLDOWN_SEG`. */
export function frequenciaDoCliqueDesktop(
  env: Record<string, string | undefined> = process.env,
): FrequenciaDoClique {
  const { intervaloCliques: i, cooldownSeg: c } = LIMITES_DA_FREQUENCIA;
  return {
    intervaloCliques: inteiroEntre(env.ANUNCIO_CLICK_DESKTOP_INTERVALO_CLIQUES, i.min, i.max, FREQUENCIA_PADRAO.intervaloCliques),
    cooldownSeg: inteiroEntre(env.ANUNCIO_CLICK_DESKTOP_COOLDOWN_SEG, c.min, c.max, FREQUENCIA_PADRAO.cooldownSeg),
  };
}

/** Valida a resposta de `/api/ads/click-desktop` no cliente. Qualquer desvio = sem anúncio. */
export function lerRespostaDoClique(dado: unknown): FrequenciaDoClique | null {
  if (!dado || typeof dado !== "object") return null;
  const r = dado as Record<string, unknown>;
  if (r.exibir !== true) return null;
  const { intervaloCliques: i, cooldownSeg: c } = LIMITES_DA_FREQUENCIA;
  const ok = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
  if (!ok(r.intervaloCliques, i.min, i.max) || !ok(r.cooldownSeg, c.min, c.max)) return null;
  return { intervaloCliques: r.intervaloCliques as number, cooldownSeg: r.cooldownSeg as number };
}

/**
 * Contador do cliente. Cliques durante o cooldown não contam. Na vez de abrir
 * (`"abrir"`), o contador só zera quando o processo principal confirma que
 * abriu (`confirmarAbertura`); se ele recusou (gesto já usado, por exemplo), o
 * próximo clique elegível tenta de novo.
 */
export function criarContadorDeCliques(freq: FrequenciaDoClique) {
  let cliques = 0;
  let ultimaAberturaEm = 0;
  return {
    registrar(agora: number): "abrir" | "contar" | "cooldown" {
      if (ultimaAberturaEm > 0 && agora - ultimaAberturaEm < freq.cooldownSeg * 1000) return "cooldown";
      cliques = Math.min(cliques + 1, freq.intervaloCliques);
      return cliques >= freq.intervaloCliques ? "abrir" : "contar";
    },
    confirmarAbertura(agora: number) {
      cliques = 0;
      ultimaAberturaEm = agora;
    },
  };
}

// ── Que cliques contam ────────────────────────────────────────────────────────

/**
 * Rotas onde nenhum clique conta: player (filme, episódio, canais ao vivo),
 * conta, assinatura, pagamento e autenticação.
 */
const ROTAS_SEM_CLIQUE = /^\/(?:assistir|player|canais|planos|checkout|conta|login|cadastro|desktop-auth|parear|admin)(?:\/|$)/;

export function rotaAceitaClique(pathname: string): boolean {
  return !ROTAS_SEM_CLIQUE.test(pathname || "/");
}

/**
 * Alvos que nunca contam: campos, controles deslizantes (volume, progresso),
 * mídia, diálogos/modais (inclui o do anúncio recompensado e seu "fechar"),
 * botões de fechar/volume/tela cheia, o banner e o que for marcado com
 * `data-no-click-ad`.
 */
export const SELETOR_SEM_CLIQUE = [
  "input", "textarea", "select", "option", "label",
  "[contenteditable]:not([contenteditable='false'])",
  "video", "audio", "iframe",
  "[role='slider']", "[role='progressbar']", "[role='dialog']", "[role='alertdialog']", "[aria-modal='true']",
  "[aria-label*='fechar' i]", "[aria-label*='close' i]",
  "[aria-label*='volume' i]", "[aria-label*='mudo' i]", "[aria-label*='mute' i]",
  "[aria-label*='tela cheia' i]", "[aria-label*='fullscreen' i]",
  "[data-banner-posicao]",
  "[data-no-click-ad]",
].join(", ");

type ElementoMinimo = { closest(seletor: string): unknown };
type LinkMinimo = { getAttribute(nome: string): string | null; target?: string };

/**
 * Link que sai do app (outra origem, `_blank`, `download`, esquema que não é
 * http/https): o próprio clique já abre algo fora. Contar o clique aí faria o
 * anúncio consumir o gesto que o link precisa — e o clique original falharia.
 */
function linkQueSai(link: LinkMinimo, origemDoApp: string): boolean {
  if (link.getAttribute("download") !== null) return true;
  const alvo = link.getAttribute("target");
  if (alvo && alvo !== "_self") return true;
  const href = link.getAttribute("href") ?? "";
  let u: URL;
  try { u = new URL(href, origemDoApp); } catch { return true; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return true;
  return u.origin !== origemDoApp;
}

export function cliqueElegivel(fatos: {
  confiavel: boolean;
  botao: number;
  alvo: ElementoMinimo | null;
  pathname: string;
  telaCheia: boolean;
  origemDoApp: string;
}): boolean {
  if (fatos.confiavel !== true) return false; // clique sintético nunca conta
  if (fatos.botao !== 0) return false; // só o botão principal
  if (fatos.telaCheia) return false;
  if (!rotaAceitaClique(fatos.pathname)) return false;
  const alvo = fatos.alvo;
  if (!alvo || typeof alvo.closest !== "function") return false;
  if (alvo.closest(SELETOR_SEM_CLIQUE)) return false;
  const link = alvo.closest("a[href]") as LinkMinimo | null;
  if (link && linkQueSai(link, fatos.origemDoApp)) return false;
  return true;
}
