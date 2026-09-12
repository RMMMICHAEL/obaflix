"use client";

import { useCallback, useRef } from "react";
import { fontesCandidatas } from "@/lib/androidMedia";

/**
 * Resolve fontes para baixar ou transmitir, fora do player.
 *
 * ## Por que não reaproveita o `extract` do CustomPlayer
 *
 * O `extract` faz muito mais do que resolver: liga o failover por epoch, agenda
 * renovação antes da expiração, aplica legendas, muda `status` e desenha o
 * player. Chamá-lo daqui, com um vídeo possivelmente tocando, mexeria no estado
 * da reprodução em curso.
 *
 * ## Por que só o caminho nativo simples
 *
 * Os ramos complicados do `extract` — `superflixLocal`, `iframeDesafio`,
 * `iframeDireto` — produzem exatamente as fontes que **não** podem ser baixadas
 * nem transmitidas: mídia presa à sessão do navegador, manifesto em memória,
 * cookie da Cloudflare. O Android recusa todas elas de qualquer forma
 * (`DownloadSourceResolver`). Então este resolvedor cobre só o que sobra, que é
 * a extração nativa comum — e não há lógica difícil duplicada em lugar nenhum.
 *
 * ## Custo
 *
 * Uma chamada a `/api/player/fontes` por conteúdo (a sessão é reaproveitada
 * entre tentativas e entre baixar/transmitir do mesmo episódio) e uma a
 * `/api/player/fonte-nativa` por servidor tentado. A extração em si roda no
 * aparelho, pelo IP do usuário — não passa pela Vercel.
 */

type Fonte = {
  id: string;
  disponivel: boolean;
  nativo: boolean;
  iframeDireto?: boolean;
  iframeDesafio?: boolean;
  superflixLocal?: unknown;
  /** Rótulo genérico que o usuário comum já vê ("Servidor 3"). */
  rotulo?: string;
};

type Resolvido = {
  origem: string;
  stream?: string;
  tipo?: string;
  referer?: string | null;
  userAgent?: string | null;
  expiresAt?: number | null;
  error?: string;
  /** Só para diagnóstico: rótulo genérico do servidor. */
  servidor?: string;
  /** Só para diagnóstico: "servidor" (API resolveu) ou "aparelho" (app extraiu). */
  via?: string;
};

type Ponte = { extractStream?: (embedUrl: string) => Promise<Resolvido> };

export function useFonteParaMidia({
  conteudoId,
  conteudoTipo,
  temporada,
  numeroEp,
}: {
  conteudoId: string;
  conteudoTipo: string;
  temporada?: number | null;
  numeroEp?: number | null;
}) {
  const sessaoRef = useRef<string | null>(null);
  const candidatasRef = useRef<Fonte[] | null>(null);

  const abrirSessao = useCallback(async () => {
    if (sessaoRef.current && candidatasRef.current) return;

    const res = await fetch("/api/player/fontes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conteudoId,
        conteudoTipo,
        temporada: temporada ?? null,
        numeroEp: numeroEp ?? null,
        ambiente: "android",
      }),
    });
    if (!res.ok) throw new Error("servidores indisponíveis");
    const data = await res.json();

    sessaoRef.current = data?.sessao ?? null;
    const lista: Fonte[] = Array.isArray(data?.fontes) ? data.fontes : [];
    candidatasRef.current = fontesCandidatas(lista);
  }, [conteudoId, conteudoTipo, temporada, numeroEp]);

  /**
   * A n-ésima fonte candidata, já resolvida.
   *
   * `null` só quando as fontes acabaram. Quando **este** servidor falha, lança:
   * assim quem procura download segue para o próximo em vez de confundir um
   * servidor quebrado com o fim da lista (ver `procurarFonteDeDownload`).
   */
  return useCallback(async (tentativa: number): Promise<Resolvido | null> => {
    await abrirSessao();
    const sessao = sessaoRef.current;
    const alvo = candidatasRef.current?.[tentativa];
    if (!sessao || !alvo) return null;

    const ponte = (window as unknown as { obaflixDesktop?: Ponte }).obaflixDesktop;
    if (!ponte?.extractStream) return null;

    const res = await fetch("/api/player/fonte-nativa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessao, fonteId: alvo.id }),
    });
    if (!res.ok) throw new Error("fonte_falhou");
    const nativa = await res.json();

    // Rótulo genérico ("Servidor 3") e o caminho que resolveu, só para o
    // diagnóstico do download. Nenhum dos dois identifica provedor, URL ou token.
    const servidor = alvo.rotulo || `Servidor ${tentativa + 1}`;

    // Algumas fontes já voltam resolvidas do servidor (`streamUrl`), outras
    // devolvem o embed para o aparelho extrair (`embedUrl`). São os dois
    // formatos que o próprio player já trata.
    if (nativa?.streamUrl) {
      return {
        origem: "nativo",
        stream: nativa.streamUrl,
        referer: nativa.referer ?? null,
        // O servidor declara o formato quando o conhece. Adivinhar pela URL
        // errava nos dois sentidos: ".m4v" virava HLS, e um HLS com ".mp4" na
        // query virava MP4. A adivinhação fica só para quando não houver tipo.
        tipo:
          nativa.tipo === "mp4" || nativa.tipo === "hls"
            ? nativa.tipo
            : String(nativa.streamUrl).includes(".mp4") ? "mp4" : "hls",
        servidor,
        via: "servidor",
      };
    }
    if (!nativa?.embedUrl) throw new Error("fonte_falhou");

    const dados = await ponte.extractStream(nativa.embedUrl);
    if (dados?.error || !dados?.stream) throw new Error("fonte_falhou");

    // `origem` diz ao Android qual caminho produziu isto. Aqui é sempre o
    // nativo comum — os caminhos de sessão foram filtrados acima.
    return { ...dados, origem: "nativo", servidor, via: "aparelho" };
  }, [abrirSessao]);
}
