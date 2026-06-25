export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, withCors } from "@/lib/auth";

export async function OPTIONS(req: NextRequest) {
  const guard = await requireAdmin(req); return guard ?? new NextResponse(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const tipo = req.nextUrl.searchParams.get("tipo") ?? "";
  const page = Number(req.nextUrl.searchParams.get("page") ?? 1);
  const take = 20;

  const where: any = {};
  if (q) where.titulo = { contains: q, mode: "insensitive" };
  if (tipo) where.tipo = tipo;

  const [items, total] = await Promise.all([
    prisma.serie.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip: (page - 1) * take,
      select: { id: true, titulo: true, poster: true, ano: true, tipo: true, tmdbId: true, _count: { select: { episodios: true } } },
    }),
    prisma.serie.count({ where }),
  ]);

  return withCors(NextResponse.json({ items, total, pages: Math.ceil(total / take) }), req);
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const body = await req.json();
  const {
    id, tmdbId, titulo, tituloOriginal, poster, background,
    sinopse, ano, nota, temporadas, tipo, generos,
  } = body;

  if (!id || !titulo) return NextResponse.json({ error: "id e titulo obrigatórios" }, { status: 400 });

  const serie = await prisma.serie.upsert({
    where: { id: String(id) },
    update: {
      tmdbId: tmdbId ? String(tmdbId) : undefined,
      titulo, tituloOriginal, poster, background, sinopse,
      ano: ano ? Number(ano) : undefined,
      nota: nota ? Number(nota) : undefined,
      temporadas: temporadas ? Number(temporadas) : undefined,
      tipo: tipo || "serie",
    },
    create: {
      id: String(id),
      tmdbId: tmdbId ? String(tmdbId) : undefined,
      titulo, tituloOriginal, poster, background, sinopse,
      ano: ano ? Number(ano) : undefined,
      nota: nota ? Number(nota) : undefined,
      temporadas: temporadas ? Number(temporadas) : undefined,
      tipo: tipo || "serie",
    },
  });

  if (Array.isArray(generos) && generos.length > 0) {
    await prisma.serieGenero.deleteMany({ where: { serieId: serie.id } });
    for (const g of generos) {
      await prisma.genero.upsert({
        where: { id: g.id },
        update: { nome: g.nome },
        create: { id: g.id, nome: g.nome },
      });
      await prisma.serieGenero.create({ data: { serieId: serie.id, generoId: g.id } });
    }
  }

  return withCors(NextResponse.json({ ok: true, id: serie.id }), req);
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const { id } = await req.json();
  await prisma.watchHistory.deleteMany({ where: { conteudoId: id } });
  await prisma.watchlist.deleteMany({ where: { conteudoId: id } });
  await prisma.serieGenero.deleteMany({ where: { serieId: id } });
  await prisma.episodio.deleteMany({ where: { serieId: id } });
  await prisma.serie.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
