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
