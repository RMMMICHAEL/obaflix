/**
 * Decisões puras das ações de Baixar e Transmitir do aplicativo Android.
 *
 * Vive em `src/lib` e não dentro dos componentes por dois motivos. O prático: é
 * onde `node --test` roda, e estas são justamente as regras que precisam de
 * teste — qual conteúdo a ação alveja, quando ela pode aparecer e o que a
 * pessoa lê quando uma fonte é recusada. O de projeto: hero, linha de episódio
 * e player precisam produzir o **mesmo** `pid` para o mesmo conteúdo, senão a
 * fila de downloads trataria o mesmo episódio como três itens diferentes.
 *
 * Nada aqui toca `window`, rede ou React.
 */

export type AlvoDeMidia =
  | { tipo: "filme"; conteudoId: string }
  | { tipo: "serie"; conteudoId: string; temporada: number; numeroEp: number };

/**
 * Lê `/assistir/filme/<id>` e `/assistir/serie/<id>/t<T>/ep<E>`.
 *
 * Animes e desenhos caem em `/assistir/serie/...` porque no catálogo são
 * séries — por isso não existe um terceiro formato aqui.
 *
 * Devolve null para qualquer outra forma. Um href inesperado significa que a
 * rota mudou; nesse caso as ações somem, que é melhor do que baixar o conteúdo
 * errado a partir de um id mal interpretado.
 */
export function alvoDoHref(href: string | null | undefined): AlvoDeMidia | null {
  if (!href) return null;
  const limpo = href.split("?")[0].split("#")[0];

  const filme = /^\/assistir\/filme\/([^/]+)\/?$/.exec(limpo);
  if (filme) return { tipo: "filme", conteudoId: decodeURIComponent(filme[1]) };

  const serie = /^\/assistir\/serie\/([^/]+)\/t(\d+)\/ep(\d+)\/?$/.exec(limpo);
  if (serie) {
    return {
      tipo: "serie",
      conteudoId: decodeURIComponent(serie[1]),
      temporada: Number(serie[2]),
      numeroEp: Number(serie[3]),
    };
  }
  return null;
}

/** Id público e estável do conteúdo. Nunca carrega nada da fonte. */
export function pidDeFilme(conteudoId: string): string {
  return `filme:${conteudoId}`;
}

export function pidDeEpisodio(serieId: string, temporada: number, numeroEp: number): string {
  return `serie:${serieId}:t${temporada}:e${numeroEp}`;
}

/**
 * O inverso de `pidDeFilme`/`pidDeEpisodio`: de volta ao conteúdo.
 *
 * É o que as ações de Baixar e Transmitir mandam a `/api/playback/authorize` —
 * o `pid` já é a identidade do conteúdo em hero, episódio e player. Qualquer
 * outra forma devolve null, e a ação não pede liberação para um conteúdo mal
 * interpretado.
 */
export function alvoDoPid(pid: string | null | undefined): AlvoDeMidia | null {
  if (!pid) return null;
  const filme = /^filme:([^:]+)$/.exec(pid);
  if (filme) return { tipo: "filme", conteudoId: filme[1] };
  const serie = /^serie:([^:]+):t(\d+):e(\d+)$/.exec(pid);
  if (serie) {
    return {
      tipo: "serie",
      conteudoId: serie[1],
      temporada: Number(serie[2]),
      numeroEp: Number(serie[3]),
    };
  }
  return null;
}

export function pidDoAlvo(alvo: AlvoDeMidia): string {
  return alvo.tipo === "filme"
    ? pidDeFilme(alvo.conteudoId)
    : pidDeEpisodio(alvo.conteudoId, alvo.temporada, alvo.numeroEp);
}

/** "O Mentalista - 1x1" para série e anime; só o título para filme. */
export function rotuloDoAlvo(titulo: string, alvo: AlvoDeMidia): string {
  return alvo.tipo === "filme" ? titulo : `${titulo} - ${alvo.temporada}x${alvo.numeroEp}`;
}

export function rotuloDeEpisodio(serieTitulo: string, temporada: number, numeroEp: number): string {
  return `${serieTitulo} - ${temporada}x${numeroEp}`;
}

export type TipoDeConteudo = "filme" | "serie" | "anime" | "desenho";

/** Identificação de um episódio. Nunca carrega nada da fonte. */
export type EpisodioRef = { temporada: number; numeroEp: number };

/**
 * O que o hero pode fazer com Baixar e Transmitir.
 *
 * Três estados porque existem três situações de verdade, e tratar duas delas
 * como a mesma foi justamente o defeito anterior: "não há mídia" e "há mídia
 * demais para adivinhar" precisam de respostas diferentes.
 */
export type DecisaoDoHero =
  /** Há uma mídia inequívoca: agir direto sobre ela. */
  | { modo: "direto"; alvo: AlvoDeMidia }
  /** Há várias: levar à lista de episódios e deixar a pessoa escolher. */
  | { modo: "escolher" }
  /** Não há nenhuma: mostrar indisponível, sem resolver fonte nenhuma. */
  | { modo: "indisponivel" };

/**
 * Decide o que o hero faz, sem tocar em rede, `window` ou React.
 *
 * ## Por que série nunca olha o `watchHref`
 *
 * O `watchHref` que a página de série monta é o do **primeiro** episódio. Usá-lo
 * faria o hero escolher em silêncio: a pessoa toca em "Baixar" numa série de
 * seis temporadas e recebe o T1E1 sem ter pedido. Aqui ele só é lido para
 * filme, onde existe uma mídia só e não há o que adivinhar.
 *
 * ## De onde vem a contagem
 *
 * [totalEpisodios] e [episodioUnico] saem da **mesma coleção** que alimenta o
 * `EpisodeGrid`. Derivar de outro lugar criaria uma segunda fonte de verdade,
 * e o hero e a lista poderiam discordar sobre quantos episódios existem.
 *
 * ## Precedência
 *
 * Retomada vem antes da contagem: se a pessoa já escolheu um episódio
 * assistindo, é esse, mesmo numa série com cem episódios.
 */
export function decidirAcaoDoHero(params: {
  tipo: TipoDeConteudo;
  conteudoId: string;
  /** Href do botão Assistir. Lido apenas quando [tipo] é "filme". */
  watchHref?: string | null;
  /** Episódio de retomada, quando o estado pessoal já chegou. */
  retomada?: EpisodioRef | null;
  /** Total de episódios disponíveis, da mesma coleção do EpisodeGrid. */
  totalEpisodios?: number;
  /** Identificação do único episódio, quando [totalEpisodios] é 1. */
  episodioUnico?: EpisodioRef | null;
}): DecisaoDoHero {
  const { tipo, conteudoId, watchHref, retomada, totalEpisodios, episodioUnico } = params;

  if (tipo === "filme") {
    const alvo = alvoDoHref(watchHref);
    // Sem href de reprodução não há mídia publicada: não inventa uma.
    return alvo?.tipo === "filme" ? { modo: "direto", alvo } : { modo: "indisponivel" };
  }

  if (!conteudoId) return { modo: "indisponivel" };

  if (retomada) {
    return {
      modo: "direto",
      alvo: {
        tipo: "serie",
        conteudoId,
        temporada: retomada.temporada,
        numeroEp: retomada.numeroEp,
      },
    };
  }

  const total = totalEpisodios ?? 0;
  if (total <= 0) return { modo: "indisponivel" };

  if (total === 1) {
    // A contagem diz que há um só, mas se a identificação não veio junto não dá
    // para saber QUAL — e chutar aqui seria repetir o erro do primeiroEp.
    if (!episodioUnico) return { modo: "indisponivel" };
    return {
      modo: "direto",
      alvo: {
        tipo: "serie",
        conteudoId,
        temporada: episodioUnico.temporada,
        numeroEp: episodioUnico.numeroEp,
      },
    };
  }

  return { modo: "escolher" };
}

/**
 * A ponte nativa de mídia, se este ambiente a tiver.
 *
 * `mediaActions` só é `true` quando a `MainActivity` do módulo `:app` registrou
 * a interface `_obaflixMedia`. O Electron também define `window.obaflixDesktop`
 * — por isso a checagem é pelo campo, e não pela existência do objeto: testar
 * só o objeto faria os botões aparecerem no Electron.
 */
export function pontesDeMidia<T extends { mediaActions?: boolean }>(
  desktop: T | undefined | null,
): T | null {
  return desktop?.mediaActions ? desktop : null;
}

/**
 * Mensagem para o usuário comum.
 *
 * Genérica de propósito: o motivo técnico (`sessao_do_navegador`, `expirada`)
 * fica no log nativo mascarado. Nome de provedor, host e token nunca aparecem
 * na tela — é a mesma regra que o resto do player já segue.
 */
export function mensagemDeFalha(motivo?: string): string {
  switch (motivo) {
    case "app_ausente":
      return "Instale o app de transmissão";
    case "sem_pasta":
      return "Nenhuma pasta escolhida";
    case "pasta_invalida":
      return "A pasta não está mais disponível";
    case "sessao_do_navegador":
      return "Nenhum servidor permite baixar este título";
    case "expirada":
    case "sondagem_expirada":
      return "O link expirou. Tente de novo";
    case "indisponivel":
      return "Indisponível neste aparelho";
    case "download_indisponivel":
    case "hls_sem_arquivo_unico":
      return "Download indisponível para este título";
    // Recusas comerciais: nunca a mensagem de "servidor" ou de mídia.
    case "anuncio_indisponivel":
      return "Anúncio indisponível no momento. Tente de novo";
    case "acao_nao_liberada":
    case "anuncio_necessario":
      return "Não foi possível liberar esta ação agora";
    case "sessao_expirada":
      return "O link expirou. Tente de novo";
    default:
      return "Não foi possível concluir";
  }
}

/**
 * As fontes que vale a pena tentar baixar ou transmitir.
 *
 * Os ramos complicados do player — `superflixLocal`, `iframeDesafio`,
 * `iframeDireto` — produzem exatamente as fontes que **não** podem sair do
 * contexto que as autorizou: mídia presa à sessão do navegador, manifesto em
 * memória, cookie da Cloudflare. O lado nativo recusa todas elas de qualquer
 * forma; filtrar aqui evita gastar uma extração para ouvir "não".
 */
export function fontesCandidatas<
  T extends {
    disponivel?: boolean;
    nativo?: boolean;
    iframeDireto?: boolean;
    iframeDesafio?: boolean;
    superflixLocal?: unknown;
  },
>(fontes: T[]): T[] {
  return fontes.filter(
    (f) => !!f.disponivel && !!f.nativo && !f.iframeDireto && !f.iframeDesafio && !f.superflixLocal,
  );
}

/**
 * Que mídia uma fonte resolvida entrega, pelo mesmo critério do
 * `DownloadSourceResolver.classificar` do Android: o tipo declarado manda, e só
 * "mp4" é arquivo direto; sem tipo, só um caminho terminado em `.mp4` é direto.
 * Todo o resto é HLS — inclusive uma URL que nem dá para ler.
 *
 * Classifica pela mídia resolvida, nunca pela posição ou pelo nome do servidor.
 */
export type MidiaDaFonte = "direta" | "hls";

export function midiaDaFonte(fonte: { stream?: string; tipo?: string | null }): MidiaDaFonte {
  if (fonte.tipo && fonte.tipo.trim() !== "") {
    return fonte.tipo.toLowerCase() === "mp4" ? "direta" : "hls";
  }
  try {
    return new URL(fonte.stream ?? "").pathname.toLowerCase().endsWith(".mp4") ? "direta" : "hls";
  } catch {
    return "hls";
  }
}

/**
 * Teto de servidores da LISTA BASE num toque em Baixar. Cada tentativa fora do
 * player custa uma chamada a `/api/player/fonte-nativa` e, possivelmente, uma
 * extração no aparelho. HLS também conta: só dá para classificá-lo DEPOIS de
 * resolver a fonte, então ele já pagou o custo — ignorá-lo no orçamento deixaria
 * o número de extrações praticamente ilimitado.
 */
export const MAX_TENTATIVAS_DE_DOWNLOAD = 6;

/**
 * Teto SEPARADO para as fontes que a fase `alternativas: true` acrescenta. É um
 * orçamento próprio, não a continuação do da base: uma base ruim com muitas
 * fontes não pode consumir as posições das alternativas antes de chegar nelas.
 */
export const MAX_TENTATIVAS_ALTERNATIVAS_DOWNLOAD = 6;

export type RespostaDeSondagem = { ok: boolean; motivo?: string; tentarOutraFonte?: boolean };

export type ResultadoDaProcura<R> = { ok: true; resposta: R } | { ok: false; motivo?: string };

/** Onde as fontes NOVAS da expansão começam, e quantas são. */
export type Expansao = { inicio: number; quantidade: number };

/**
 * Procura a fonte de download em DUAS fases, cada uma com orçamento próprio.
 *
 *  1. **base** — até `maxTentativas` fontes da lista base;
 *  2. **alternativas** — se a base não achou download (esgotou OU consumiu o
 *     orçamento), `expandir()` traz as fontes extras da MESMA sessão (fase
 *     `alternativas: true`) UMA vez, e tenta até `maxAlternativas` fontes
 *     **novas**, com orçamento à parte.
 *
 * Duas fases, e não um índice linear de 12: uma base com 8 fontes ruins não
 * gasta as posições das alternativas — tenta `maxTentativas` da base e segue
 * para as novas. Sem `expandir`, ou com expansão que não cresce, fica só a fase
 * 1 (idêntico ao comportamento anterior). O player não usa isto: só o download.
 *
 * Preferência MP4 → HLS, sem re-resolver nada: dentro das fases, o arquivo
 * direto (MP4) é sondado na hora; um HLS resolvido é **guardado** (não sondado
 * ainda) e a procura segue atrás de MP4. Só quando nenhum MP4 é aceito é que os
 * HLS guardados são sondados, na ordem — o primeiro compatível vence, e um HLS
 * incompatível (`tentarOutraFonte=true`) deixa o próximo ser tentado. O HLS
 * nunca é re-resolvido/reextraído: sonda-se a mesma `FonteResolvida` guardada.
 *
 * `resolverFonte(indice)` devolve `null` quando aquele índice não existe e lança
 * quando um servidor específico falhou — a procura segue para o próximo em vez
 * de desistir no primeiro servidor quebrado. Não resolve nem troca a fonte que
 * está tocando: o que cada tentativa devolve é decisão de quem chama.
 */
export async function procurarFonteDeDownload<
  F extends { stream?: string; tipo?: string | null; servidor?: string; via?: string },
  R extends RespostaDeSondagem,
>(params: {
  /** Resolve a fonte no índice ABSOLUTO (base e, após `expandir`, alternativas). */
  resolverFonte: (indice: number) => Promise<F | null>;
  sondar: (fonte: F) => Promise<R>;
  /**
   * Expande a MESMA sessão (fase `alternativas: true`) uma vez e devolve onde as
   * fontes NOVAS começam e quantas são — ou `null` em falha/sem crescimento.
   * Nunca abre sessão nem pede anúncio. Ausente: sem fase 2.
   */
  expandir?: () => Promise<Expansao | null>;
  /** Orçamento da fase base. */
  maxTentativas?: number;
  /** Orçamento da fase alternativas. */
  maxAlternativas?: number;
  /** Diagnóstico de cada tentativa. Ver [EventoDeProcura] e [linhaDiagDownload]. */
  registrar?: (evento: EventoDeProcura) => void;
}): Promise<ResultadoDaProcura<R>> {
  const {
    resolverFonte, sondar, expandir,
    maxTentativas = MAX_TENTATIVAS_DE_DOWNLOAD,
    maxAlternativas = MAX_TENTATIVAS_ALTERNATIVAS_DOWNLOAD,
  } = params;
  // Log que quebra não pode derrubar o download.
  const registrar = (evento: EventoDeProcura) => {
    try {
      params.registrar?.(evento);
    } catch {
      /* diagnóstico é acessório */
    }
  };
  let viuHls = false;
  let ultimo: R | null = null;
  let contador = 0; // tentativa contínua entre as fases, só para o diagnóstico
  // HLS resolvidos mas ainda não sondados: tentados só depois que nenhum MP4
  // serviu, sem resolver/extrair de novo.
  const hlsPendentes: F[] = [];

  type Saida =
    | { tipo: "aceita"; resposta: R }
    /** Cancelamento/recusa comercial: encerra tudo, sem expandir. */
    | { tipo: "terminal"; motivo?: string }
    /** Android recusou e disse que outra fonte não ajuda: encerra, sem expandir. */
    | { tipo: "parar" }
    /** Fase acabou (lista esgotou ou orçamento consumido): pode expandir. */
    | { tipo: "segue" };

  const fase = async (inicio: number, max: number): Promise<Saida> => {
    for (let i = 0; i < max; i++) {
      const tentativa = contador;
      let fonte: F | null;
      try {
        fonte = await resolverFonte(inicio + i);
      } catch (erro) {
        const nome = (erro as { name?: unknown } | null)?.name;
        // Fechar o convite de anúncio, ir assinar ou ter a ação recusada
        // comercialmente encerram a procura inteira: tentar outro servidor
        // abriria o modal de novo, ou repetiria a mesma recusa.
        if (nome === "AcaoCancelada") {
          registrar({ tentativa, resultado: "falhou", motivo: "cancelado" });
          return { tipo: "terminal", motivo: "cancelado" };
        }
        if (nome === "AcaoInterrompida") {
          const motivo = String((erro as { motivo?: unknown }).motivo ?? "acao_nao_liberada");
          registrar({ tentativa, resultado: "falhou", motivo });
          return { tipo: "terminal", motivo };
        }
        // Este servidor falhou; os próximos ainda podem servir.
        registrar({ tentativa, resultado: "falhou" });
        contador++;
        continue;
      }
      if (!fonte) {
        registrar({ tentativa, resultado: "fim" });
        return { tipo: "segue" };
      }

      const identidade = { servidor: fonte.servidor, via: fonte.via };
      const midia = midiaDaFonte(fonte);
      if (midia === "hls") {
        // Guarda para depois; a preferência é MP4. Nada de sondar HLS agora.
        viuHls = true;
        hlsPendentes.push(fonte);
        registrar({ tentativa, resultado: "pulada_hls", midia, ...identidade });
        contador++;
        continue;
      }

      let r: R;
      try {
        r = await sondar(fonte);
      } catch {
        r = { ok: false } as R;
      }
      if (r.ok) {
        registrar({ tentativa, resultado: "aceita", midia, ...identidade });
        return { tipo: "aceita", resposta: r };
      }
      registrar({ tentativa, resultado: "recusada", midia, motivo: r.motivo, ...identidade });
      ultimo = r;
      contador++;
      // Só insiste quando o Android disse que outra fonte pode servir.
      if (!r.tentarOutraFonte) return { tipo: "parar" };
    }
    return { tipo: "segue" }; // orçamento consumido
  };

  const encerrar = (): ResultadoDaProcura<R> => ({
    ok: false,
    motivo: viuHls ? "download_indisponivel" : ultimo?.motivo,
  });

  /**
   * Fallback: sonda os HLS já resolvidos, na ordem, sem resolver/extrair de novo.
   * O primeiro compatível vence; um incompatível que peça outra fonte
   * (`tentarOutraFonte`) deixa o próximo HLS ser tentado.
   */
  const tentarHls = async (): Promise<ResultadoDaProcura<R>> => {
    for (const fonte of hlsPendentes) {
      const identidade = { servidor: fonte.servidor, via: fonte.via };
      let r: R;
      try {
        r = await sondar(fonte);
      } catch {
        r = { ok: false } as R;
      }
      if (r.ok) {
        registrar({ tentativa: contador, resultado: "aceita", midia: "hls", ...identidade });
        return { ok: true, resposta: r };
      }
      registrar({ tentativa: contador, resultado: "recusada", midia: "hls", motivo: r.motivo, ...identidade });
      ultimo = r;
      contador++;
      if (!r.tentarOutraFonte) break;
    }
    return encerrar();
  };

  const base = await fase(0, maxTentativas);
  if (base.tipo === "aceita") return { ok: true, resposta: base.resposta };
  if (base.tipo === "terminal") return { ok: false, motivo: base.motivo };
  if (base.tipo === "parar") return encerrar();

  // Fase 2 (MP4): expande a MESMA sessão uma vez e tenta só as fontes NOVAS, com
  // orçamento próprio. Falha/sem crescimento mantém a base.
  if (expandir) {
    let expansao: Expansao | null;
    try {
      expansao = await expandir();
    } catch (erro) {
      // Sessão expirada/recusa da ação também são terminais na expansão.
      // Não sondar HLS guardados depois de perder a sessão autorizada.
      const nome = (erro as { name?: unknown } | null)?.name;
      if (nome === "AcaoCancelada") return { ok: false, motivo: "cancelado" };
      if (nome === "AcaoInterrompida") {
        return { ok: false, motivo: String((erro as { motivo?: unknown }).motivo ?? "acao_nao_liberada") };
      }
      expansao = null;
    }
    if (expansao && expansao.quantidade > 0) {
      const alt = await fase(expansao.inicio, Math.min(expansao.quantidade, maxAlternativas));
      if (alt.tipo === "aceita") return { ok: true, resposta: alt.resposta };
      if (alt.tipo === "terminal") return { ok: false, motivo: alt.motivo };
      if (alt.tipo === "parar") return encerrar();
    }
  }

  // Nenhum MP4 aceito: agora sim os HLS guardados (base + alternativas).
  return tentarHls();
}

/**
 * Um passo da procura de download, para diagnóstico.
 *
 * Só classificação e identificação genérica: nunca URL, token, Referer nem nome
 * real de provedor. `servidor` é o rótulo que o usuário comum já vê ("Servidor 3").
 */
export type EventoDeProcura = {
  tentativa: number;
  resultado: "aceita" | "recusada" | "pulada_hls" | "falhou" | "fim";
  midia?: MidiaDaFonte;
  motivo?: string;
  servidor?: string;
  /** "servidor" quando a mídia veio resolvida da API; "aparelho" quando o app extraiu. */
  via?: string;
};

/** Valor seguro para log: só letras, números, `_`, `.` e `-`; o que parecer URL vira "mascarado". */
function valorDeLog(valor: string | undefined, limite = 32): string | undefined {
  if (!valor) return undefined;
  if (/https?:|\/\/|[?&=]/i.test(valor)) return "mascarado";
  const limpo = valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return limpo ? limpo.slice(0, limite) : undefined;
}

/**
 * A linha de diagnóstico de um passo da procura.
 *
 * Usa o canal `[diag/etapa]`, o único que o `MainActivity` repassa ao logcat
 * mesmo num APK de release (vira `diag_etapa` com os campos `chave=valor`).
 */
export function linhaDiagDownload(evento: EventoDeProcura): string {
  const campos: Array<[string, string | number | undefined]> = [
    ["etapa", "DOWNLOAD_FONTE"],
    ["tentativa", evento.tentativa],
    ["resultado", evento.resultado],
    ["midia", evento.midia],
    ["via", valorDeLog(evento.via)],
    ["servidor", valorDeLog(evento.servidor)],
    ["motivo", valorDeLog(evento.motivo)],
  ];
  const partes = campos
    .filter(([, valor]) => valor !== undefined && valor !== "")
    .map(([chave, valor]) => `${chave}=${valor}`);
  return `[diag/etapa] ${partes.join(" ")}`;
}

// ── Coordenadas de episódio fora do player ────────────────────────────────────

/**
 * Orçamento para tentar coordenadas alternativas de UMA fonte fora do player
 * (download e transmissão). A primeira tentativa sempre roda, com os prazos de
 * sempre; as seguintes só começam enquanto a fonte não passou deste tempo.
 * Sem teto, 4 coordenadas × (fonte-nativa + extração) somariam minutos com o
 * anúncio já consumido.
 */
export const ORCAMENTO_COORDENADAS_MS = 45_000;
/** Mesmo teto do servidor (`MAX_TENTATIVAS_COORDENADA`). */
export const MAX_COORDENADAS_POR_FONTE = 4;

export type RespostaFonteNativa = {
  embedUrl?: string;
  streamUrl?: string;
  referer?: string | null;
  tipo?: string | null;
  /** Quantas coordenadas o servidor tem para esta fonte. Ausente: 1. */
  tentativas?: unknown;
};

export type ResolucaoComCoordenadas<D> =
  | { via: "servidor"; nativa: RespostaFonteNativa }
  | { via: "aparelho"; dados: D };

/**
 * Resolve uma fonte percorrendo as coordenadas de episódio que o servidor
 * declara (ver `src/lib/episodeCoordinates.ts`) — o mesmo que o player faz,
 * com o servidor como autoridade: aqui só circula o índice.
 *
 * - `pedirFonte(t)` chama `/api/player/fonte-nativa` para a coordenada `t` e
 *   lança se a rota recusar;
 * - `extrair` roda o extrator do aparelho e lança se não houver mídia.
 *
 * Mídia resolvida no servidor (`streamUrl`) volta direto: lá as coordenadas já
 * foram percorridas. Prazo estourado na extração encerra a fonte — outra
 * coordenada do mesmo provedor pendurado só gastaria mais tempo. Tudo falhando,
 * relança o último erro, como a tentativa única sempre fez.
 */
export async function resolverComCoordenadas<D>(deps: {
  pedirFonte: (tentativa: number) => Promise<RespostaFonteNativa>;
  extrair: (embedUrl: string) => Promise<D>;
  ehPrazoEstourado?: (erro: unknown) => boolean;
  agora?: () => number;
  orcamentoMs?: number;
}): Promise<ResolucaoComCoordenadas<D>> {
  const agora = deps.agora ?? (() => Date.now());
  const orcamento = deps.orcamentoMs ?? ORCAMENTO_COORDENADAS_MS;
  const estourou = deps.ehPrazoEstourado ?? ((e: unknown) => (e as { name?: unknown } | null)?.name === "EtapaExpirada");
  const inicio = agora();
  let total = 1;
  let ultimoErro: unknown = new Error("fonte_falhou");

  for (let t = 0; t < total && t < MAX_COORDENADAS_POR_FONTE; t++) {
    if (t > 0 && agora() - inicio >= orcamento) break;
    let nativa: RespostaFonteNativa;
    try {
      nativa = await deps.pedirFonte(t);
    } catch (erro) {
      if (t === 0) throw erro;
      ultimoErro = erro;
      break;
    }
    const declarado = Number(nativa?.tentativas);
    if (Number.isInteger(declarado) && declarado >= 1) total = Math.min(declarado, MAX_COORDENADAS_POR_FONTE);
    if (nativa?.streamUrl) return { via: "servidor", nativa };
    if (!nativa?.embedUrl) {
      if (t === 0) throw new Error("fonte_falhou");
      break;
    }
    try {
      return { via: "aparelho", dados: await deps.extrair(nativa.embedUrl) };
    } catch (erro) {
      ultimoErro = erro;
      if (estourou(erro)) break;
    }
  }
  throw ultimoErro;
}
