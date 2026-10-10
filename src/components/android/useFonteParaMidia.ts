"use client";

import { useCallback, useMemo, useRef } from "react";
import { fontesCandidatas, resolverComCoordenadas, type Expansao } from "@/lib/androidMedia";
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
 * No player, `capturarSessaoDoPlayer` fornece a sessão existente e o download
 * usa uma extração nativa isolada. A página individual mantém o fluxo abaixo.
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
 * Um toque novo é uma ação nova, e quem o inicia chama `reiniciarAcao` antes.
 *
 * Uma sessão de download nunca serve transmissão, e nenhuma delas nasce de uma
 * concessão de reprodução — a finalidade viaja até o servidor e é conferida lá.
 *
 * ## Mesma sessão, lista que cresce (só download)
 *
 * Como o player, a procura de download pode expandir a MESMA sessão com
 * `alternativas: true` — uma vez, aditiva. É aí que mora o MP4 baixável quando a
 * base é toda HLS (pulada) ou falha. `expandirAlternativas` **não** abre sessão
 * nova, **não** pede anúncio e **não** consome concessão: o servidor só confere
 * o dono da sessão e acrescenta fontes. Quem orquestra as fases e os orçamentos
 * é `procurarFonteDeDownload`; aqui só resolvemos a fonte no índice pedido e
 * informamos onde as novas começam.
 *
 * ## Custo
 *
 * Uma chamada a `/api/playback/authorize` e uma a `/api/player/fontes` por ação
 * (mais uma, no download, se a fase alternativas for necessária), e uma a
 * `/api/player/fonte-nativa` por servidor tentado. A extração em si roda no
 * aparelho, pelo IP do usuário — não passa pela Vercel.
 */

type FinalidadeDeMidia = "download" | "transmissao";

export type FonteDeMidia = {
  id: string;
  disponivel: boolean;
  nativo: boolean;
  iframeDireto?: boolean;
  iframeDesafio?: boolean;
  superflixLocal?: unknown;
  /** Rótulo genérico que o usuário comum já vê ("Servidor 3"). */
  rotulo?: string;
};
type Fonte = FonteDeMidia;

export type MidiaResolvida = {
  origem?: string;
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
type Resolvido = MidiaResolvida;

type Ponte = {
  extractStream?: (embedUrl: string) => Promise<Resolvido>;
  extractStreamForDownload?: (embedUrl: string, actionId: string) => Promise<Resolvido>;
};

type SessaoDaAcao = { sessao: string; candidatas: Fonte[]; expandida: boolean };

export type SessaoDownloadDoPlayer = {
  sessao: string;
  base: Fonte[];
  atual?: { fonteId: string; midia: Resolvido };
  /** Fase já iniciada pelo playback. Só lê seu resultado, sem publicar lista. */
  alternativas?: Promise<Fonte[] | null>;
};

type Liberar = (finalidade: FinalidadeDeMidia) => Promise<string | null>;

/** Contexto privado por clique. A procura e os orçamentos continuam em androidMedia. */
export function criarDownloadDoPlayer(deps: {
  capturar: () => SessaoDownloadDoPlayer | null;
  autorizar: (sessao: string, liberar: Liberar) => Promise<void>;
  resolver: (sessao: string, fonte: Fonte, actionId: string) => Promise<Resolvido | null>;
  expandir: (sessao: string) => Promise<Fonte[] | null>;
}) {
  type Acao = {
    snapshot: SessaoDownloadDoPlayer;
    candidatas: Fonte[];
    ids: Set<string>;
    actionId: string;
    expandida: boolean;
  };
  let snapshot: SessaoDownloadDoPlayer | null = null;
  let inicializacao: Promise<Acao> | null = null;

  const reiniciarAcao = (finalidade: FinalidadeDeMidia) => {
    if (finalidade !== "download") return;
    const capturada = deps.capturar();
    snapshot = capturada ? {
      ...capturada,
      base: capturada.base.map((f) => ({ ...f })),
      atual: capturada.atual ? { ...capturada.atual, midia: { ...capturada.atual.midia } } : undefined,
    } : null;
    inicializacao = null;
  };

  const iniciar = (liberar: Liberar): Promise<Acao> => {
    if (inicializacao) return inicializacao;
    const capturada = snapshot;
    // A Promise permanece memorizada mesmo após recusa/timeout: não cobrar de novo.
    inicializacao = (async () => {
      if (!capturada?.sessao) throw new AcaoInterrompida("sessao_expirada");
      const ids = new Set<string>();
      const candidatas: Fonte[] = [];
      if (capturada.atual) {
        ids.add(capturada.atual.fonteId);
        candidatas.push({ id: capturada.atual.fonteId, disponivel: true, nativo: true });
      }
      for (const fonte of fontesCandidatas(capturada.base)) {
        if (ids.has(fonte.id)) continue;
        ids.add(fonte.id);
        candidatas.push(fonte);
      }
      await deps.autorizar(capturada.sessao, liberar);
      return { snapshot: capturada, candidatas, ids, actionId: crypto.randomUUID(), expandida: false };
    })();
    return inicializacao;
  };

  const resolverFonte = async (indice: number, finalidade: FinalidadeDeMidia, liberar: Liberar) => {
    if (finalidade !== "download") return null;
    const acao = await iniciar(liberar);
    const fonte = acao.candidatas[indice];
    if (!fonte) return null;
    if (fonte.id === acao.snapshot.atual?.fonteId) return acao.snapshot.atual.midia;
    return deps.resolver(acao.snapshot.sessao, fonte, acao.actionId);
  };

  const expandirAlternativas = async (finalidade: FinalidadeDeMidia): Promise<Expansao | null> => {
    if (finalidade !== "download" || !inicializacao) return null;
    const acao = await inicializacao;
    if (acao.expandida) return null;
    acao.expandida = true;
    const lista = acao.snapshot.alternativas
      ? await acao.snapshot.alternativas
      : await deps.expandir(acao.snapshot.sessao);
    if (!lista) return null;
    const inicio = acao.candidatas.length;
    for (const fonte of fontesCandidatas(lista)) {
      if (acao.ids.has(fonte.id)) continue;
      acao.ids.add(fonte.id);
      acao.candidatas.push(fonte);
    }
    return { inicio, quantidade: acao.candidatas.length - inicio };
  };

  return { resolverFonte, expandirAlternativas, reiniciarAcao };
}

/** Resolução compartilhada pela página e pelo player; o extrator é uma dependência. */
export async function resolverCandidataDeMidia(
  sessao: string,
  alvo: Fonte,
  extrair: (embedUrl: string) => Promise<Resolvido>,
  sessaoTerminal = false,
): Promise<Resolvido> {
  const servidor = alvo.rotulo || "Servidor";
  const resolvida = await resolverComCoordenadas<Resolvido>({
    pedirFonte: async (coordenada) => {
      const res = await fetchComPrazo("/api/player/fonte-nativa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(coordenada === 0
          ? { sessao, fonteId: alvo.id }
          : { sessao, fonteId: alvo.id, tentativa: coordenada }),
      }, PRAZO_FONTE_NATIVA_MS, "fonte-nativa");
      if (sessaoTerminal && res.status === 410) throw new AcaoInterrompida("sessao_expirada");
      if (!res.ok) throw new Error("fonte_falhou");
      return res.json();
    },
    extrair: async (embedUrl) => {
      const dados = await corridaComPrazo(extrair(embedUrl), PRAZO_EXTRACAO_MS, "extracao");
      if (dados?.error || !dados?.stream) throw new Error("fonte_falhou");
      return dados;
    },
  });
  if (resolvida.via === "servidor") {
    const nativa = resolvida.nativa;
    return {
      origem: "nativo", stream: nativa.streamUrl, referer: nativa.referer ?? null,
      tipo: nativa.tipo === "mp4" || nativa.tipo === "hls"
        ? nativa.tipo : String(nativa.streamUrl).includes(".mp4") ? "mp4" : "hls",
      servidor, via: "servidor",
    };
  }
  return { ...resolvida.dados, origem: "nativo", servidor, via: "aparelho" };
}

export async function autorizarDownloadNaSessao(
  sessao: string,
  alvo: { conteudoId: string; conteudoTipo: string; temporada?: number | null; numeroEp?: number | null },
  liberar: Liberar,
): Promise<void> {
  const concessao = await liberar("download");
  let res: Response;
  try {
    res = await fetchComPrazo("/api/player/fontes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...alvo, sessao, acao: true, finalidade: "download", ambiente: "android",
        ...(concessao ? { concessao } : {}) }),
    }, PRAZO_FONTES_MS, "fontes");
  } catch {
    throw new AcaoInterrompida("servidores_indisponiveis");
  }
  if (res.status === 410) throw new AcaoInterrompida("sessao_expirada");
  if (res.status === 403) throw new AcaoInterrompida("acao_nao_liberada");
  if (!res.ok) throw new AcaoInterrompida("servidores_indisponiveis");
}

export function useFonteParaMidia({
  conteudoId,
  conteudoTipo,
  temporada,
  numeroEp,
  capturarSessaoDoPlayer,
}: {
  conteudoId: string;
  conteudoTipo: string;
  temporada?: number | null;
  numeroEp?: number | null;
  capturarSessaoDoPlayer?: () => SessaoDownloadDoPlayer | null;
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

  /** Um toque novo é uma ação nova: descarta a sessão (e o anúncio) da anterior. */
  const reiniciarAcao = useCallback((finalidade: FinalidadeDeMidia) => {
    sessoesRef.current[finalidade] = undefined;
  }, []);

  /**
   * Fase alternativas sobre a MESMA sessão (o que o player já faz na reprodução):
   * `/api/player/fontes` com `alternativas: true`. O servidor confere o dono da
   * sessão (`diagnosticarSessao`) e acrescenta fontes — sem anúncio, sem
   * concessão, sem sessão nova e sem aceitar URL do cliente.
   *
   * Aditiva, à prova de falha e **uma vez por sessão** (`expandida`): devolve
   * onde as fontes NOVAS começam e quantas são, ou `null` em `!ok`, timeout, erro
   * ou quando nada cresceu — nesses casos a lista base fica intacta.
   */
  const expandirAlternativas = useCallback(
    async (finalidade: FinalidadeDeMidia): Promise<Expansao | null> => {
      const atual = sessoesRef.current[finalidade];
      if (!atual || atual.expandida) return null;
      atual.expandida = true;
      const antes = atual.candidatas.length;
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
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        const lista: Fonte[] = Array.isArray(data?.fontes) ? data.fontes : [];
        const expandidas = fontesCandidatas(lista);
        if (expandidas.length <= antes) return null;
        atual.candidatas = expandidas;
        return { inicio: antes, quantidade: expandidas.length - antes };
      } catch {
        return null;
      }
    },
    [conteudoId, conteudoTipo, temporada, numeroEp],
  );

  /**
   * A fonte candidata no índice pedido, já resolvida.
   *
   * `null` quando aquele índice não existe (base ainda sem expandir, ou lista
   * esgotada). Quando **este** servidor falha, lança: assim quem procura download
   * segue para o próximo em vez de confundir um servidor quebrado com o fim da
   * lista (ver `procurarFonteDeDownload`). A sessão é aberta na primeira chamada,
   * consumindo a liberação; as seguintes reaproveitam.
   */
  const resolverFonte = useCallback(
    async (
      indice: number,
      finalidade: FinalidadeDeMidia,
      liberar?: (finalidade: FinalidadeDeMidia) => Promise<string | null>,
    ): Promise<Resolvido | null> => {
      // Sem a ponte nativa não há o que extrair — e, portanto, nenhum anúncio é
      // pedido por uma ação que não teria como acontecer.
      const ponte = (window as unknown as { obaflixDesktop?: Ponte }).obaflixDesktop;
      if (!ponte?.extractStream) return null;

      const atual = sessoesRef.current[finalidade] ?? (await abrirSessao(finalidade, liberar));
      const alvo = atual.candidatas[indice];
      if (!alvo) return null;

      return resolverCandidataDeMidia(atual.sessao, { ...alvo, rotulo: alvo.rotulo || `Servidor ${indice + 1}` },
        (embedUrl) => ponte.extractStream!(embedUrl));
    },
    [abrirSessao],
  );

  const downloadDoPlayer = useMemo(() => capturarSessaoDoPlayer ? criarDownloadDoPlayer({
    capturar: capturarSessaoDoPlayer,
    autorizar: (sessao, liberar) => autorizarDownloadNaSessao(sessao, {
      conteudoId, conteudoTipo, temporada: temporada ?? null, numeroEp: numeroEp ?? null,
    }, liberar),
    resolver: async (sessao, fonte, actionId) => {
      const extrair = (window as unknown as { obaflixDesktop?: Ponte }).obaflixDesktop?.extractStreamForDownload;
      // APK anterior: conserva a mídia atual, sem recorrer à extração de playback.
      if (!extrair) return null;
      return resolverCandidataDeMidia(sessao, fonte, (embedUrl) => extrair(embedUrl, actionId), true);
    },
    expandir: async (sessao) => {
      const res = await fetchComPrazo("/api/player/fontes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conteudoId, conteudoTipo, temporada: temporada ?? null,
          numeroEp: numeroEp ?? null, ambiente: "android", sessao, alternativas: true }),
      }, PRAZO_FONTES_MS, "alternativas");
      if (res.status === 410) throw new AcaoInterrompida("sessao_expirada");
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data?.fontes) ? data.fontes as Fonte[] : null;
    },
  }) : null, [capturarSessaoDoPlayer, conteudoId, conteudoTipo, temporada, numeroEp]);

  return downloadDoPlayer ?? { resolverFonte, expandirAlternativas, reiniciarAcao };
}
