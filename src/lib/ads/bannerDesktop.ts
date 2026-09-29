/**
 * O banner publicitário do aplicativo Windows (Monetag In-Page Push), pura.
 *
 * Responde uma pergunta só: **esta requisição deve receber o banner?** Não fala
 * com Redis, banco nem `NextRequest` — quem busca os fatos é
 * `src/app/api/ads/banner-desktop/route.ts`.
 *
 * ## Onde o banner vive, e por que ali
 *
 * Só no Electron. O script de terceiros roda num documento próprio
 * (`public/desktop/banner.html`) carregado num iframe `sandbox` **sem**
 * `allow-same-origin`: origem opaca, sem acesso ao `parent` (onde mora a ponte
 * `obaflixDesktop`), sem cookie, sem storage, sem service worker, sem navegação
 * da janela principal e sem download. Ver `src/components/ads/BannerDesktop.tsx`.
 *
 * ## O que decide
 *
 *  1. **flag de servidor** — `ANUNCIO_BANNER_DESKTOP_ATIVO`, só a string exata
 *     `"true"` liga. Desliga o banner sem deploy nem EXE novo;
 *  2. **ambiente** — só `desktop`. Navegador e Android recebem `false` antes de
 *     qualquer consulta: a web nunca paga Redis/Postgres por esta rota;
 *  3. **direito** — `exigeAnuncio(direitos)`, a mesma regra do resto da
 *     monetização, sobre `entitlementsDoUsuario` (fonte canônica: Postgres,
 *     cache Redis de 120 s). Assinante pago tem `anunciosObrigatorios = false`
 *     e não vê banner. Nenhuma comparação por nome de plano.
 *
 * ## Para que lado falha
 *
 * Não conseguir resolver o direito de quem está logado (`indefinido`) **não**
 * mostra banner: na dúvida, não incomodar quem pode estar pagando. Sem sessão
 * não há assinatura — mostra.
 *
 * O ambiente vem de User-Agent/header, que o cliente escolhe. Não é problema:
 * o pior que um cliente forjado ganha é *ver* um banner. Esconder o banner
 * sempre foi possível no cliente (é conteúdo exibido nele); o que o servidor
 * garante é o outro lado — assinante nunca recebe `exibir: true`.
 */

import type { Ambiente } from "../../config/site-mode";
import type { DireitosDoPlano } from "../planos";
import { exigeAnuncio } from "./politica";

/** Liga o banner. Servidor-only, mesma leitura estrita das outras flags de anúncio. */
export function bannerDesktopAtivo(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ANUNCIO_BANNER_DESKTOP_ATIVO === "true";
}

export type ContaDoBanner =
  /** Sem sessão. */
  | { tipo: "anonima" }
  /** Sessão válida e direitos resolvidos. */
  | { tipo: "resolvida"; direitos: DireitosDoPlano }
  /** Sessão válida, mas os direitos não puderam ser resolvidos. */
  | { tipo: "indefinida" };

export function decidirBannerDesktop(fatos: {
  ativo: boolean;
  ambiente: Ambiente;
  conta: ContaDoBanner;
}): boolean {
  if (!fatos.ativo) return false;
  if (fatos.ambiente !== "desktop") return false;
  switch (fatos.conta.tipo) {
    case "anonima":
      return true;
    case "resolvida":
      return exigeAnuncio(fatos.conta.direitos);
    default:
      return false;
  }
}

/**
 * O único documento que carrega o script publicitário. Estático, sem
 * querystring: nada da sessão, do título aberto ou do usuário chega ao
 * anunciante pela URL. Mora sob `/desktop/`, então o middleware já o recusa a
 * navegador e Android (`decidirRota`).
 */
export const DOCUMENTO_DO_BANNER = "/desktop/banner.html";

/**
 * Permissões do iframe. **Sem `allow-same-origin`** — é isso que isola: com ele,
 * um documento do nosso próprio host alcançaria `parent.obaflixDesktop` e o
 * DOM do app. Sem `allow-top-navigation*` (não troca a janela principal), sem
 * `allow-downloads`, sem `allow-forms`, sem `allow-modals` e sem
 * `allow-popups-to-escape-sandbox` (uma janela que o anúncio abrir herda o
 * sandbox). `allow-popups` fica: o clique no anúncio abre o destino, e o
 * Electron manda todo destino externo ao navegador do sistema.
 */
export const SANDBOX_DO_BANNER = "allow-scripts allow-popups";

// ── Posições (placements) ─────────────────────────────────────────────────────

/**
 * Onde o banner aparece. Cada posição vira o hash do documento isolado
 * (`/desktop/banner.html#feed`): o hash não vai ao servidor, não fragmenta
 * cache e não sai no Referer. É lá, e só lá, que a posição vira zona Monetag
 * (tabela `ZONAS` em `public/desktop/banner.html`). Hoje as três usam a única
 * zona criada; zonas por posição precisam ser criadas no painel da Monetag.
 */
export const POSICOES_DO_BANNER = ["feed", "detalhe", "player"] as const;
export type PosicaoDoBanner = (typeof POSICOES_DO_BANNER)[number];

export function urlDoBanner(posicao: PosicaoDoBanner): string {
  return `${DOCUMENTO_DO_BANNER}#${posicao}`;
}

/**
 * Altura do iframe por posição, em px. `inicial` é a janela que a tag recebe
 * para renderizar; o detector só pode **aumentar** a caixa (até `maxima`),
 * nunca encolher abaixo da inicial — encolher reposicionaria um criativo
 * ancorado ao rodapé a cada medição.
 */
export const ALTURA_DO_BANNER: Record<PosicaoDoBanner, { inicial: number; maxima: number }> = {
  feed: { inicial: 120, maxima: 250 },
  detalhe: { inicial: 120, maxima: 250 },
  player: { inicial: 110, maxima: 160 },
};

export function alturaDoIframe(posicao: PosicaoDoBanner, reportada: number): number {
  const { inicial, maxima } = ALTURA_DO_BANNER[posicao];
  if (!Number.isFinite(reportada)) return inicial;
  return Math.min(maxima, Math.max(inicial, Math.ceil(reportada)));
}

/**
 * Sem anúncio real em até este tempo desde que o documento carregou, o espaço
 * inteiro some (label inclusa) e o iframe é desmontado — a tag para de rodar.
 */
export const TEMPO_SEM_ANUNCIO_MS = 10_000;

// ── Mensagem do documento isolado ─────────────────────────────────────────────

export type EstadoDoBanner = { estado: "anuncio"; altura: number } | { estado: "vazio" };

/**
 * Valida o que o documento isolado manda por `postMessage`. Formato fechado:
 * qualquer outra coisa é descartada. Quem chama ainda confere que `source` é o
 * iframe deste slot e que `origin` é `"null"` (origem opaca do sandbox).
 *
 * A mensagem não é confiável por natureza — o script do anúncio roda no mesmo
 * documento e pode forjá-la. O pior que ela faz é *mostrar* a caixa; não abre
 * nada, não navega, não alcança a ponte. Por isso é aceitável.
 */
export function lerMensagemDoBanner(dado: unknown): EstadoDoBanner | null {
  if (!dado || typeof dado !== "object") return null;
  const m = dado as Record<string, unknown>;
  if (m.obaflixBanner !== 1) return null;
  if (m.estado === "vazio") return { estado: "vazio" };
  if (m.estado === "anuncio" && typeof m.altura === "number" && Number.isFinite(m.altura) && m.altura >= 0) {
    return { estado: "anuncio", altura: Math.min(m.altura, 10_000) };
  }
  return null;
}

// ── Recuo quando não há inventário ────────────────────────────────────────────

/**
 * Cada slot sem anúncio custa um documento, a tag (~150 KB, em cache) e as
 * chamadas da Monetag. Sem inventário (IP/geo sem demanda), uma Home com uma
 * dúzia de slots repetiria isso a cada rolagem. Depois de `limite` falhas
 * seguidas, novos slots ficam em pausa por `pausaMs`. Um anúncio entregue zera.
 */
export function criarControleDeFalhas(limite = 3, pausaMs = 120_000) {
  let seguidas = 0;
  let pausaAte = 0;
  return {
    podeTentar(agora: number) {
      return agora >= pausaAte;
    },
    registrarFalha(agora: number) {
      seguidas += 1;
      if (seguidas >= limite) {
        pausaAte = agora + pausaMs;
        seguidas = 0;
      }
    },
    registrarSucesso() {
      seguidas = 0;
      pausaAte = 0;
    },
  };
}
