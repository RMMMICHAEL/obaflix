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
};

type Resolvido = {
  origem: string;
  stream?: string;
  tipo?: string;
  referer?: string | null;
  userAgent?: string | null;
  expiresAt?: number | null;
  error?: string;
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

  /** A n-ésima fonte candidata, já resolvida. `null` quando acabaram. */
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
    if (!res.ok) return null;
    const nativa = await res.json();

    // Algumas fontes já voltam resolvidas do servidor (`streamUrl`), outras
    // devolvem o embed para o aparelho extrair (`embedUrl`). São os dois
    // formatos que o próprio player já trata.
    if (nativa?.streamUrl) {
      return {
        origem: "nativo",
        stream: nativa.streamUrl,
        referer: nativa.referer ?? null,
        tipo: String(nativa.streamUrl).includes(".mp4") ? "mp4" : "hls",
      };
    }
    if (!nativa?.embedUrl) return null;

    const dados = await ponte.extractStream(nativa.embedUrl);
    if (dados?.error || !dados?.stream) return null;

    // `origem` diz ao Android qual caminho produziu isto. Aqui é sempre o
    // nativo comum — os caminhos de sessão foram filtrados acima.
    return { ...dados, origem: "nativo" };
  }, [abrirSessao]);
}
