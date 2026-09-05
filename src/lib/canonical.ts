/**
 * Identidade canonica do catalogo.
 *
 * O catalogo tem tres pipelines de importacao e cada um escolheu um espaco de
 * id diferente para a chave primaria: o id do Megaflix (`"98765"`), o id do
 * WebCine prefixado (`"wc_4412"`) e o proprio tmdbId (`"124364"`). Os tres sao
 * estruturalmente incapazes de colidir, entao o mesmo titulo virava tres linhas
 * e cada uma ficava com a fatia de episodios que a sua fonte trouxe.
 *
 * `tmdbId` + tipo de midia e a chave canonica porque e a unica presente em
 * TODAS as fontes — todo importador ja descarta item sem `tmdb_id` — e porque
 * `sync-top250` e `popular-sync` ja usam esse eixo. O `id` continua sendo a
 * chave primaria opaca: trocar isso invalidaria links, historico e watchlist ja
 * gravados.
 *
 * Este modulo e puro de proposito. As mesmas funcoes decidem o vencedor no
 * merge que escreve no banco e na deduplicacao que protege as leituras, entao
 * os dois nunca podem discordar sobre qual registro e o bom.
 */

/** Media a que uma linha pertence. `Filme` e `Serie` sao tabelas separadas. */
export type TipoMidia = "filme" | "serie";

/**
 * O minimo que uma linha precisa expor para ser deduplicada.
 *
 * Deliberadamente frouxo: as leituras que consomem isto (busca, /melhores,
 * vitrines) selecionam conjuntos de colunas diferentes, e obrigar todas ao
 * mesmo `select` custaria banda por nada.
 */
export interface RegistroCatalogo {
  id: string;
  tmdbId?: string | null;
  /** "serie" | "anime" | "desenho" nas series; ausente ou "filme" nos filmes. */
  tipo?: string | null;
  titulo?: string | null;
  tituloOriginal?: string | null;
  poster?: string | null;
  background?: string | null;
  logo?: string | null;
  sinopse?: string | null;
  ano?: number | null;
  nota?: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  /** Quantos episodios com fonte a linha tem, quando o chamador ja sabe. */
  episodios?: number | null;
  createdAt?: Date | string | null;
}

/**
 * A que midia a linha pertence.
 *
 * `tipo` na tabela Serie guarda a secao do catalogo ("serie", "anime",
 * "desenho"), nao a midia — as tres sao series. Colapsar por secao seria errado
 * nos dois sentidos: uma serie reclassificada de "serie" para "anime" viraria
 * duas linhas distintas, e e exatamente esse o caso que o cron do WebCine
 * produzia ao trazer o mesmo titulo pelos endpoints de series e de animes.
 */
export function tipoMidia(registro: RegistroCatalogo): TipoMidia {
  return registro.tipo === undefined || registro.tipo === null || registro.tipo === "filme"
    ? "filme"
    : "serie";
}

/**
 * Chave canonica, ou `null` quando a linha nao pode ser provada duplicata.
 *
 * Sem `tmdbId` nao ha prova de identidade — e agrupar por titulo foi
 * exatamente o erro do script de limpeza anterior, que apagava "Lanternas" de
 * 2011 por causa de "Lanternas" de 2024. Linha sem tmdbId nunca colapsa.
 */
export function canonicalKey(registro: RegistroCatalogo): string | null {
  const tmdbId = registro.tmdbId?.trim();
  if (!tmdbId) return null;
  return `${tipoMidia(registro)}:${tmdbId}`;
}

/** Campos que contam como metadata preenchida na hora de eleger o vencedor. */
const CAMPOS_METADATA = [
  "titulo",
  "tituloOriginal",
  "poster",
  "background",
  "logo",
  "sinopse",
  "ano",
  "nota",
] as const;

/**
 * Quao completo um registro e. Maior vence.
 *
 * Os pesos sao degraus, nao ajustes finos: um unico episodio com fonte vale
 * mais que toda a metadata somada, porque metadata se rebusca no TMDB e
 * episodio perdido nao volta. Em seguida vem ter player proprio (filme), e so
 * entao a contagem de campos preenchidos, que serve de desempate.
 */
export function pontuarRegistro(registro: RegistroCatalogo): number {
  let pontos = 0;

  if (registro.episodios && registro.episodios > 0) pontos += registro.episodios * 1_000;
  if (registro.urlDub || registro.urlLeg) pontos += 500;

  for (const campo of CAMPOS_METADATA) {
    const valor = registro[campo];
    if (valor !== null && valor !== undefined && valor !== "") pontos += 10;
  }

  return pontos;
}

function tempo(valor: Date | string | null | undefined): number {
  if (!valor) return Number.POSITIVE_INFINITY;
  const ms = valor instanceof Date ? valor.getTime() : new Date(valor).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Ordena do melhor para o pior. Use com `[...linhas].sort(compararRegistros)`.
 *
 * O desempate final e o registro MAIS ANTIGO, nao o mais novo: ele e o que tem
 * mais chance de ja estar em links, historico e watchlist de usuario. Manter o
 * antigo torna o merge menos observavel para quem ja usava o catalogo.
 *
 * `id` fecha a ordem para o resultado ser estavel entre execucoes — sem isso o
 * dry-run e o apply poderiam eleger vencedores diferentes.
 */
export function compararRegistros(a: RegistroCatalogo, b: RegistroCatalogo): number {
  const porPontos = pontuarRegistro(b) - pontuarRegistro(a);
  if (porPontos !== 0) return porPontos;

  const porIdade = tempo(a.createdAt) - tempo(b.createdAt);
  if (porIdade !== 0 && Number.isFinite(porIdade)) return porIdade;

  return a.id.localeCompare(b.id);
}

/** O registro que deve sobreviver a um grupo de duplicatas. */
export function elegerVencedor<T extends RegistroCatalogo>(grupo: readonly T[]): T {
  if (grupo.length === 0) throw new Error("elegerVencedor: grupo vazio");
  return [...grupo].sort(compararRegistros)[0];
}

/** Um grupo de linhas que representam o mesmo titulo. */
export interface GrupoCanonico<T extends RegistroCatalogo> {
  chave: string;
  vencedor: T;
  perdedores: T[];
}

/**
 * Agrupa linhas duplicadas por chave canonica.
 *
 * Devolve so os grupos com mais de uma linha — quem esta sozinho nao interessa
 * a nenhum dos dois consumidores.
 */
export function agruparDuplicatas<T extends RegistroCatalogo>(
  registros: readonly T[],
): GrupoCanonico<T>[] {
  const porChave = new Map<string, T[]>();

  for (const registro of registros) {
    const chave = canonicalKey(registro);
    if (!chave) continue;
    const grupo = porChave.get(chave);
    if (grupo) grupo.push(registro);
    else porChave.set(chave, [registro]);
  }

  const grupos: GrupoCanonico<T>[] = [];
  for (const [chave, linhas] of porChave) {
    if (linhas.length < 2) continue;
    const ordenadas = [...linhas].sort(compararRegistros);
    grupos.push({ chave, vencedor: ordenadas[0], perdedores: ordenadas.slice(1) });
  }

  return grupos.sort((a, b) => a.chave.localeCompare(b.chave));
}

/**
 * Colapsa duplicatas de uma lista ja ordenada, preservando a ordem.
 *
 * A posicao e a da PRIMEIRA ocorrencia, e o conteudo e o do melhor registro do
 * grupo. Essa distincao importa em ranking: em /melhores as linhas chegam
 * ordenadas por `top250`, e as tres duplicatas de um titulo carregam o mesmo
 * rank. Manter a posicao da primeira e trocar o conteudo pelo mais completo
 * devolve o titulo uma vez, no lugar certo, com os episodios que ele de fato
 * tem — em vez de tres cards, um deles marcado como indisponivel.
 *
 * Defesa em profundidade: o merge no banco e a correcao de verdade. Isto
 * protege enquanto ele nao roda e cobre qualquer fonte nova que volte a
 * duplicar. Roda em memoria sobre resultado ja buscado, sem consulta extra.
 */
/**
 * Linha vinda do Prisma com a contagem de episodios em `_count`.
 *
 * O `select` do Prisma devolve `{ _count: { episodios } }`, e `pontuarRegistro`
 * espera `episodios` na raiz. A adaptacao vive aqui em vez de em cada pagina
 * porque errar isso e silencioso: sem a contagem, a linha com 0 episodios pode
 * ganhar da que tem player so por ter a sinopse preenchida.
 */
export interface LinhaPrisma {
  id: string;
  tmdbId?: string | null;
  tipo?: string | null;
  _count?: { episodios: number };
}

/**
 * Deduplicacao para listas que sairam direto do Prisma.
 *
 * Adapta `_count.episodios`, fixa a midia (a tabela ja diz qual e) e devolve as
 * linhas originais, sem os campos auxiliares que a pontuacao usou.
 */
export function dedupeCatalogo<T extends LinhaPrisma>(
  linhas: readonly T[],
  midia: TipoMidia,
): T[] {
  const comCriterio = linhas.map((linha) => ({
    ...linha,
    tipo: midia,
    episodios: linha._count?.episodios,
  }));

  return dedupeCanonical(comCriterio).map(({ tipo, episodios, ...linha }) => linha as unknown as T);
}

export function dedupeCanonical<T extends RegistroCatalogo>(registros: readonly T[]): T[] {
  const posicaoPorChave = new Map<string, number>();
  const resultado: T[] = [];

  for (const registro of registros) {
    const chave = canonicalKey(registro);

    // Sem tmdbId nao ha prova de duplicata: passa direto, sempre.
    if (!chave) {
      resultado.push(registro);
      continue;
    }

    const posicao = posicaoPorChave.get(chave);
    if (posicao === undefined) {
      posicaoPorChave.set(chave, resultado.length);
      resultado.push(registro);
      continue;
    }

    if (compararRegistros(registro, resultado[posicao]) < 0) {
      resultado[posicao] = registro;
    }
  }

  return resultado;
}
