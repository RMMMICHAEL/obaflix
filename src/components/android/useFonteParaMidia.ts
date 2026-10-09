"use client";

import { useCallback, useRef } from "react";
import { fontesCandidatas, resolverComCoordenadas, resolverCandidataExpandindo } from "@/lib/androidMedia";
import { AcaoInterrompida } from "@/lib/ads/acaoPatrocinada";
import {
  corridaComPrazo,
  fetchComPrazo,
  PRAZO_EXTRACAO_MS,
  PRAZO_FONTE_NATIVA_MS,
  PRAZO_FONTES_MS,
} from "@/lib/androidCast";

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
 * ## Mesma sessão, lista que cresce
 *
 * Como o player, quando a lista base se esgota a procura expande a MESMA sessão
 * com `alternativas: true` — uma vez, aditiva. É aí que mora o MP4 baixável
 * quando a base é toda HLS (pulada) ou falha. A expansão **não** abre sessão
 * nova, **não** pede anúncio e **não** consome concessão: o servidor só confere
 * o dono da sessão e acrescenta fontes. Falha/timeout da fase 2 mantém a base.
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

type SessaoDaAcao = { sessao: string; candidatas: Fonte[]; expandida: boolean };

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
        // Com prazo: abrir a sessão é a etapa que carrega o anúncio já
        // consumido, então um estouro aqui é terminal (vira AcaoInterrompida) —
        // reabrir a sessão pediria um segundo anúncio, o que não pode acontecer.
        res = await fetchComPrazo(
          "/api/player/fontes",
          {
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
          },
          PRAZO_FONTES_MS,
          "fontes",
        );
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
      const aberta: SessaoDaAcao = { sessao, candidatas: fontesCandidatas(lista), expandida: false };
      sessoesRef.current[finalidade] = aberta;
      return aberta;
    },
    [conteudoId, conteudoTipo, temporada, numeroEp],
  );

  /**
   * Fase alternativas sobre a MESMA sessão de download (o que o player já faz na
   * reprodução): `/api/player/fontes` com `alternativas: true`. É o servidor que,
   * já conferindo o dono da sessão (`diagnosticarSessao`), acrescenta fontes —
   * sem anúncio, sem concessão, sem sessão nova e sem aceitar URL do cliente.
   *
   * Aditiva e à prova de falha: devolve a lista crescida (base + alternativas) ou
   * a própria base em `!ok`, timeout ou erro — a fase 2 nunca quebra a base.
   */
  const expandirFontes = useCallback(
    async (atual: SessaoDaAcao): Promise<Fonte[]> => {
      try {
        const res = await fetchComPrazo(
          "/api/player/fontes",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conteudoId,
              conteudoTipo,
              temporada: temporada ?? null,
              numeroEp: numeroEp ?? null,
              ambiente: "android",
              sessao: atual.sessao,
              alternativas: true,
            }),
          },
          PRAZO_FONTES_MS,
          "alternativas",
        );
        if (!res.ok) return atual.candidatas;
        const data = await res.json().catch(() => null);
        const lista: Fonte[] = Array.isArray(data?.fontes) ? data.fontes : [];
        const expandidas = fontesCandidatas(lista);
        return expandidas.length > atual.candidatas.length ? expandidas : atual.candidatas;
      } catch {
        return atual.candidatas;
      }
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

      // Quando a lista base acaba, expande a MESMA sessão (fase alternativas) uma
      // vez antes de dar por encerrada — o MP4 baixável pode estar só na lista
      // expandida. A expansão não abre sessão nem pede anúncio.
      return resolverCandidataExpandindo<Fonte, Resolvido>({
        tentativa,
        sessao: atual,
        expandir: () => expandirFontes(atual),
        resolver: async (alvo, i) => {
          // Rótulo genérico ("Servidor 3") e o caminho que resolveu, só para o
          // diagnóstico do download. Nenhum dos dois identifica provedor, URL ou token.
          const servidor = alvo.rotulo || `Servidor ${i + 1}`;
          const extrair = (embedUrl: string) => ponte.extractStream!(embedUrl);

          // Coordenadas de episódio (ver src/lib/episodeCoordinates.ts): quando o
          // provedor numera as temporadas de outro jeito, o servidor declara mais
          // de uma, e a mesma fonte é tentada em cada uma — o que o player já
          // fazia. Só circula o índice; a coordenada real sai do servidor.
          const resolvida = await resolverComCoordenadas<Resolvido>({
            // Com prazo. A sessão já está aberta: um estouro aqui derruba só este
            // servidor (EtapaExpirada sobe como falha de servidor) e a procura
            // segue para o próximo, sem novo anúncio.
            pedirFonte: async (coordenada) => {
              const res = await fetchComPrazo(
                "/api/player/fonte-nativa",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(coordenada === 0
                    ? { sessao: atual.sessao, fonteId: alvo.id }
                    : { sessao: atual.sessao, fonteId: alvo.id, tentativa: coordenada }),
                },
                PRAZO_FONTE_NATIVA_MS,
                "fonte-nativa",
              );
              if (!res.ok) throw new Error("fonte_falhou");
              return res.json();
            },
            // Com prazo: a extração roda no aparelho e é a etapa mais sujeita a
            // pendurar. Estourar aqui derruba só este servidor; a procura tenta o
            // próximo, ainda sem novo anúncio.
            extrair: async (embedUrl) => {
              const dados = await corridaComPrazo(extrair(embedUrl), PRAZO_EXTRACAO_MS, "extracao");
              if (dados?.error || !dados?.stream) throw new Error("fonte_falhou");
              return dados;
            },
          });

          // Algumas fontes já voltam resolvidas do servidor (`streamUrl`), outras
          // devolvem o embed para o aparelho extrair (`embedUrl`). São os dois
          // formatos que o próprio player já trata.
          if (resolvida.via === "servidor") {
            const nativa = resolvida.nativa;
            return {
              origem: "nativo",
              stream: nativa.streamUrl,
              referer: nativa.referer ?? null,
              // O servidor declara o formato quando o conhece. Adivinhar pela URL
              // errava nos dois sentidos: ".m4v" virava HLS, e um HLS com ".mp4"
              // na query virava MP4. A adivinhação fica só para quando não houver tipo.
              tipo:
                nativa.tipo === "mp4" || nativa.tipo === "hls"
                  ? nativa.tipo
                  : String(nativa.streamUrl).includes(".mp4") ? "mp4" : "hls",
              servidor,
              via: "servidor",
            };
          }

          // `origem` diz ao Android qual caminho produziu isto. Aqui é sempre o
          // nativo comum — os caminhos de sessão foram filtrados acima.
          return { ...resolvida.dados, origem: "nativo", servidor, via: "aparelho" };
        },
      });
    },
    [abrirSessao, expandirFontes],
  );
}
