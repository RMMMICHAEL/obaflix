import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { parseSeoParam } from "@/lib/catalog-url";
import { groupGenres, type GenreOption } from "@/lib/genres";

/**
 * O gênero é resolvido a partir do parâmetro `<slug>--<id>` (ou do id puro
 * legado). O `cache` do React dedupe layout, generateMetadata e página numa
 * consulta só por request.
 *
 * Fase 4: um id duplicado (ex. terror 27) resolve para o grupo semântico inteiro.
 * O retorno traz o canônico (`id` = menor id do grupo), o `nome` do representante
 * e `ids` com todos os membros equivalentes — é com `ids` que a página consulta o
 * catálogo consolidado e decide o redirect canônico.
 *
 * Uma única consulta por request (a tabela de gêneros é pequena, ~dezenas de
 * linhas): lê todos os gêneros e agrupa em memória, sem N+1.
 */
export const buscarGeneroPorParam = cache(async (param: string): Promise<GenreOption | null> => {
  const id = Number(parseSeoParam(param));
  if (!Number.isInteger(id) || id <= 0) return null;

  const todos = await prisma.genero.findMany({ select: { id: true, nome: true } });
  const grupo = groupGenres(todos).find((g) => g.ids.includes(id));
  return grupo ?? null;
});
