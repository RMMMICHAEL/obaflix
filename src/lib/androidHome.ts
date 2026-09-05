/**
 * Forma dos itens da home do app Android.
 *
 * Vive fora da pagina porque o defeito era exatamente aqui: o `select` nao
 * pedia `logo` e o tipo do item nao tinha o campo, entao todo card da home caia
 * para o rotulo de texto — enquanto o resto do projeto desenhava o logo oficial
 * do TMDB dentro do banner. Um `select` incompleto nao quebra nada visivel no
 * codigo; so a tela fica diferente. Aqui isso pode ser verificado.
 */

export type TipoCard = "filme" | "serie" | "anime" | "desenho";

/** Exatamente o que o LandscapeCard consome em /filmes, /series e /animes. */
export interface ItemTrilha {
  id: string;
  tipo: TipoCard;
  titulo: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  ano: number | null;
  nota: number | null;
  isNew: boolean;
}

/** "Adicionado recentemente" dura 3 dias. */
export const NEW_MS = 3 * 24 * 60 * 60 * 1000;
/** "Episodio novo" dura 48h. */
export const NEW_EP_MS = 48 * 60 * 60 * 1000;

/** Quanto cada prateleira mostra depois de deduplicada. */
export const POR_TRILHA = 18;
/** Quanto se busca antes: a folga cobre as duplicatas que o colapso remove. */
export const BUSCA = 24;

/**
 * Colunas que a home precisa.
 *
 * `logo` e o campo que faltava. `tmdbId` entra para a deduplicacao canonica e
 * nunca chega ao card.
 */
export const CAMPOS_TRILHA = [
  "id",
  "tmdbId",
  "titulo",
  "poster",
  "background",
  "logo",
  "ano",
  "nota",
  "createdAt",
] as const;

/**
 * Linha do banco -> item de prateleira.
 *
 * Tudo o que nao esta na lista de campos fica de fora por construcao: e assim
 * que `urlDub`/`urlLeg`, usados so como criterio de desempate entre duplicatas,
 * nunca alcancam o cache nem o HTML.
 */
export function paraTrilha(
  linha: {
    id: string;
    titulo: string;
    poster?: string | null;
    background?: string | null;
    logo?: string | null;
    ano?: number | null;
    nota?: number | null;
    createdAt?: Date | string | null;
  },
  tipo: TipoCard,
  agora: number = Date.now(),
): ItemTrilha {
  return {
    id: linha.id,
    tipo,
    titulo: linha.titulo,
    poster: linha.poster ?? null,
    background: linha.background ?? null,
    logo: linha.logo ?? null,
    ano: linha.ano ?? null,
    nota: linha.nota ?? null,
    isNew: linha.createdAt
      ? agora - new Date(linha.createdAt).getTime() < NEW_MS
      : false,
  };
}

/** Item do carrossel de destaque, na forma que o HeroSlider consome. */
export interface ItemHero {
  id: string;
  tipo: "filme";
  titulo: string;
  sinopse: string | null;
  background: string;
  trailerKey: null;
}

/**
 * Destaques -> carrossel.
 *
 * Sem `background` nao ha hero: o card ficaria com fundo vazio. A consulta ja
 * pagava por 8 linhas e a versao anterior usava so a primeira — as outras sete
 * eram buscadas e descartadas.
 */
export function paraHero(
  linhas: Array<{ id: string; titulo: string; sinopse?: string | null; background?: string | null }>,
): ItemHero[] {
  return linhas
    .filter((linha): linha is typeof linha & { background: string } => Boolean(linha.background))
    .map((linha) => ({
      id: linha.id,
      tipo: "filme" as const,
      titulo: linha.titulo,
      sinopse: linha.sinopse ?? null,
      background: linha.background,
      trailerKey: null,
    }));
}
