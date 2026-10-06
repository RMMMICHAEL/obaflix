import type { Prisma } from "@prisma/client";

/** Disponibilidade do catálogo, aplicada no banco antes de limit/count. */
export const FONTE_REPRODUZIVEL = {
  OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
};
export const FILME_REPRODUZIVEL: Prisma.FilmeWhereInput = FONTE_REPRODUZIVEL;
export const SERIE_REPRODUZIVEL: Prisma.SerieWhereInput = {
  episodios: { some: FONTE_REPRODUZIVEL },
};

export function filmeDisponivel(extra: Prisma.FilmeWhereInput = {}): Prisma.FilmeWhereInput {
  return { AND: [FILME_REPRODUZIVEL, extra] };
}

export function serieDisponivel(extra: Prisma.SerieWhereInput = {}): Prisma.SerieWhereInput {
  return { AND: [SERIE_REPRODUZIVEL, extra] };
}

/** O NOT protege inclusive stubs que posteriormente receberam conteúdo real. */
export const FILME_STUB_SEM_PLAYER: Prisma.FilmeWhereInput = {
  id: { startsWith: "tmdb_" }, NOT: FILME_REPRODUZIVEL,
};
export const SERIE_STUB_SEM_PLAYER: Prisma.SerieWhereInput = {
  id: { startsWith: "tmdb_" }, NOT: SERIE_REPRODUZIVEL,
};
