export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { upsertCatalogEpisode } from "@/lib/catalog-write";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const serieId = req.nextUrl.searchParams.get("serieId");
  if (!serieId) return NextResponse.json({ error: "serieId obrigatório" }, { status: 400 });

  const episodios = await prisma.episodio.findMany({
    where: { serieId },
    orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
  });

  return NextResponse.json(episodios);
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const body = await req.json();
  const { id, serieId, numeroEp, temporada, titulo, thumbnail, urlDub, urlLeg } = body;

  if (!serieId || !numeroEp || !temporada) {
    return NextResponse.json({ error: "serieId, numeroEp e temporada obrigatórios" }, { status: 400 });
  }

  const ep = await upsertCatalogEpisode({ id, serieId, numeroEp, temporada, titulo, thumbnail, urlDub, urlLeg }, undefined, { emptyStringClears: true });
  return NextResponse.json({ ok: true, id: ep.id });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const { id } = await req.json();
  await prisma.watchHistory.deleteMany({ where: { episodioId: id } });
  await prisma.episodio.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
