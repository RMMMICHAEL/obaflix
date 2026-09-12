"use client";

import { useCallback, useRef } from "react";
import { fontesCandidatas } from "@/lib/androidMedia";
import { AcaoInterrompida } from "@/lib/ads/acaoPatrocinada";

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
 * ## Uma liberação por ação
 *
 * Baixar e transmitir são ações patrocinadas: a conta sujeita a anúncio libera
 * cada uma assistindo a um. Por isso a sessão de fontes é **por procura e por
 * finalidade**: a primeira tentativa pede a liberação (`liberar`) e abre a sessão
 * com a finalidade e a concessão — que `/api/player/fontes` consome no servidor
 * antes de entregar qualquer fonte. As tentativas seguintes da mesma procura
 * reaproveitam essa sessão, então trocar de servidor não pede anúncio de novo.
 * Um toque novo é uma ação nova.
 *
 * Uma sessão de download nunca serve transmissão, e nenhuma delas nasce de uma
 * concessão de reprodução — a finalidade viaja até o servidor e é conferida lá.
 *
 * ## Custo
 *
 * Uma chamada a `/api/playback/authorize` e uma a `/api/player/fontes` por ação,
 * mais uma a `/api/player/fonte-nativa` por servidor tentado. A extração em si
 * roda no aparelho, pelo IP do usuário — não passa pela Vercel.
 */

type FinalidadeDeMidia = "download" | "transmissao";

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

type SessaoDaAcao = { sessao: string; candidatas: Fonte[] };

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
  const sessoesRef = useRef<Partial<Record<FinalidadeDeMidia, SessaoDaAcao>>>({});

  const abrirSessao = useCallback(
    async (
      finalidade: FinalidadeDeMidia,
      liberar?: (finalidade: FinalidadeDeMidia) => Promise<string | null>,
    ): Promise<SessaoDaAcao> => {
      // A liberação vem antes da sessão. Fechar o convite ou ir assinar lança
      // `AcaoCancelada`, e uma recusa comercial lança `AcaoInterrompida` — as
      // duas sobem sem abrir sessão nenhuma.
      const concessao = liberar ? await liberar(finalidade) : null;

      let res: Response;
      try {
        res = await fetch("/api/player/fontes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conteudoId,
            conteudoTipo,
            temporada: temporada ?? null,
            numeroEp: numeroEp ?? null,
            ambiente: "android",
            finalidade,
            ...(concessao ? { concessao } : {}),
          }),
        });
      } catch {
        throw new AcaoInterrompida("servidores_indisponiveis");
      }

      if (!res.ok) {
        const recusa = await res.json().catch(() => null);
        // Recusa comercial não é "servidor fora": motivo próprio, e a procura
        // para aqui em vez de pedir anúncio de novo na próxima tentativa.
        if (res.status === 403 && (recusa?.codigo === "anuncio_necessario" || recusa?.codigo === "conteudo_indisponivel_no_plano")) {
          throw new AcaoInterrompida("acao_nao_liberada");
        }
        throw new AcaoInterrompida("servidores_indisponiveis");
      }

      const data = await res.json().catch(() => null);
      const sessao = typeof data?.sessao === "string" ? data.sessao : null;
      if (!sessao) throw new AcaoInterrompida("servidores_indisponiveis");

      const lista: Fonte[] = Array.isArray(data?.fontes) ? data.fontes : [];
      const aberta = { sessao, candidatas: fontesCandidatas(lista) };
      sessoesRef.current[finalidade] = aberta;
      return aberta;
    },
    [conteudoId, conteudoTipo, temporada, numeroEp],
  );

  /**
   * A n-ésima fonte candidata desta ação, já resolvida.
   *
   * `null` só quando as fontes acabaram. Quando **este** servidor falha, lança:
   * assim quem procura download segue para o próximo em vez de confundir um
   * servidor quebrado com o fim da lista (ver `procurarFonteDeDownload`).
   */
  return useCallback(
    async (
      tentativa: number,
      finalidade: FinalidadeDeMidia,
      liberar?: (finalidade: FinalidadeDeMidia) => Promise<string | null>,
    ): Promise<Resolvido | null> => {
      // Sem a ponte nativa não há o que extrair — e, portanto, nenhum anúncio é
      // pedido por uma ação que não teria como acontecer.
      const ponte = (window as unknown as { obaflixDesktop?: Ponte }).obaflixDesktop;
      if (!ponte?.extractStream) return null;

      // A primeira tentativa é uma ação nova: descarta a sessão da anterior.
      if (tentativa === 0) sessoesRef.current[finalidade] = undefined;
      const atual = sessoesRef.current[finalidade] ?? (await abrirSessao(finalidade, liberar));

      const alvo = atual.candidatas[tentativa];
      if (!alvo) return null;

      const res = await fetch("/api/player/fonte-nativa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessao: atual.sessao, fonteId: alvo.id }),
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
    },
    [abrirSessao],
  );
}
