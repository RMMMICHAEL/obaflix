export type TipoCard = "filme" | "serie" | "anime" | "desenho";

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

export const NEW_MS = 3 * 24 * 60 * 60 * 1000;
export const NEW_EP_MS = 48 * 60 * 60 * 1000;
export const POR_TRILHA = 18;
export const BUSCA = 24;

/** Remove cópias de um mesmo título sem depender do módulo de catálogo que não
 * existe nesta linha de manutenção. Prefere tmdbId quando disponível. */
export function dedupeAndroid<T extends { id: string; tmdbId?: string | null; titulo?: string }>(linhas: T[]): T[] {
  const vistos = new Set<string>();
  return linhas.filter((linha) => {
    const chave = linha.tmdbId ?? `${linha.titulo ?? ""}:${linha.id}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

export function paraTrilha(
  linha: { id: string; titulo: string; poster?: string | null; background?: string | null; logo?: string | null; ano?: number | null; nota?: number | null; createdAt?: Date | string | null },
  tipo: TipoCard,
  agora: number = Date.now(),
): ItemTrilha {
  return {
    id: linha.id, tipo, titulo: linha.titulo, poster: linha.poster ?? null,
    background: linha.background ?? null, logo: linha.logo ?? null,
    ano: linha.ano ?? null, nota: linha.nota ?? null,
    isNew: linha.createdAt ? agora - new Date(linha.createdAt).getTime() < NEW_MS : false,
  };
}

export interface ItemHero {
  id: string;
  tipo: "filme";
  titulo: string;
  sinopse: string | null;
  background: string;
  trailerKey: null;
}

export function paraHero(
  linhas: Array<{ id: string; titulo: string; sinopse?: string | null; background?: string | null }>,
): ItemHero[] {
  return linhas
    .filter((linha): linha is typeof linha & { background: string } => Boolean(linha.background))
    .map((linha) => ({ id: linha.id, tipo: "filme", titulo: linha.titulo, sinopse: linha.sinopse ?? null, background: linha.background, trailerKey: null }));
}
