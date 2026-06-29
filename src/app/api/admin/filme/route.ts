export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getMovieImages, pickLogo } from "@/lib/tmdb";

// GET — lista filmes com busca
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const page = Number(req.nextUrl.searchParams.get("page") ?? 1);
  const take = 20;

  const where = q ? { titulo: { contains: q, mode: "insensitive" as const } } : {};

  const [items, total] = await Promise.all([
    prisma.filme.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip: (page - 1) * take,
      select: { id: true, titulo: true, poster: true, ano: true, urlDub: true, urlLeg: true, tmdbId: true },
    }),
    prisma.filme.count({ where }),
  ]);

  return NextResponse.json({ items, total, pages: Math.ceil(total / take) });
}

// POST — cria ou atualiza filme
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const body = await req.json();
  const {
    id, tmdbId, titulo, tituloOriginal, poster, background,
    sinopse, ano, nota, duracao, urlDub, urlLeg, generos,
  } = body;

  if (!id || !titulo) return NextResponse.json({ error: "id e titulo obrigatórios" }, { status: 400 });

  // Busca logo do TMDB se tmdbId fornecido
  let logo: string | null = null;
  if (tmdbId) {
    const imgs = await getMovieImages(tmdbId).catch(() => null);
    logo = pickLogo(imgs) ?? null;
  }

  const filme = await prisma.filme.upsert({
    where: { id: String(id) },
    update: {
      tmdbId: tmdbId ? String(tmdbId) : undefined,
      titulo, tituloOriginal, poster, background, sinopse,
      ano: ano ? Number(ano) : undefined,
      nota: nota ? Number(nota) : undefined,
      duracao: duracao ? Number(duracao) : undefined,
      urlDub: urlDub || null,
      urlLeg: urlLeg || null,
      ...(logo ? { logo } : {}),
    },
    create: {
      id: String(id),
      tmdbId: tmdbId ? String(tmdbId) : undefined,
      titulo, tituloOriginal, poster, background, sinopse,
      ano: ano ? Number(ano) : undefined,
      nota: nota ? Number(nota) : undefined,
      duracao: duracao ? Number(duracao) : undefined,
      urlDub: urlDub || null,
      urlLeg: urlLeg || null,
      logo,
    },
  });

  // Upsert gêneros
  if (Array.isArray(generos) && generos.length > 0) {
    await prisma.filmeGenero.deleteMany({ where: { filmeId: filme.id } });
    for (const g of generos) {
      await prisma.genero.upsert({
        where: { id: g.id },
        update: { nome: g.nome },
        create: { id: g.id, nome: g.nome },
      });
      await prisma.filmeGenero.create({ data: { filmeId: filme.id, generoId: g.id } });
    }
  }

  return NextResponse.json({ ok: true, id: filme.id });
}

// DELETE — remove filme
export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const { id } = await req.json();
  await prisma.filmeGenero.deleteMany({ where: { filmeId: id } });
  await prisma.watchHistory.deleteMany({ where: { conteudoId: id } });
  await prisma.watchlist.deleteMany({ where: { conteudoId: id } });
  await prisma.filme.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
