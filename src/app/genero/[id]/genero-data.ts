import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { parseSeoParam } from "@/lib/catalog-url";

/**
 * O gênero é resolvido a partir do parâmetro `<slug>--<id>` (ou do id puro
 * legado). O `cache` do React dedupe layout, generateMetadata e página numa
 * consulta só por request.
 */
export const buscarGeneroPorParam = cache(async (param: string) => {
  const id = Number(parseSeoParam(param));
  if (!Number.isInteger(id) || id <= 0) return null;
  return prisma.genero.findUnique({ where: { id }, select: { id: true, nome: true } });
});
