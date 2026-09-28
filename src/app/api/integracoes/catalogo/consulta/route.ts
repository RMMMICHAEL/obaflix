import { NextRequest, NextResponse } from "next/server";
import { requireCatalogSync } from "@/lib/catalogSyncAuth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/requestSecurity";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;

const ids = (value: unknown): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS) return null;
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()))];
};

/**
 * `POST /api/integracoes/catalogo/consulta` — o que já existe no catálogo.
 *
 * Corpo: `{ filmes?: string[], series?: string[] }` (até 500 IDs cada).
 * Resposta: `{ filmes: { [id]: true }, series: { [id]: { episodios } } }`.
 * Só identidade e contagem: nenhum título, URL de mídia ou dado de usuário.
 * Substitui as leituras que os produtores faziam em `/api/admin/{filme,serie}`.
 */
export async function POST(req: NextRequest) {
  const guard = await requireCatalogSync(req); if (guard) return guard;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  const filmeIds = ids(body.filmes);
  const serieIds = ids(body.series);
  if (!filmeIds || !serieIds) return NextResponse.json({ error: `filmes e series devem ser listas de até ${MAX_IDS} IDs` }, { status: 400 });

  const [filmes, series] = await Promise.all([
    filmeIds.length ? prisma.filme.findMany({ where: { id: { in: filmeIds } }, select: { id: true } }) : [],
    serieIds.length ? prisma.serie.findMany({ where: { id: { in: serieIds } }, select: { id: true, _count: { select: { episodios: true } } } }) : [],
  ]);
  return NextResponse.json({
    filmes: Object.fromEntries(filmes.map((f) => [f.id, true])),
    series: Object.fromEntries(series.map((s) => [s.id, { episodios: s._count.episodios }])),
  });
}
