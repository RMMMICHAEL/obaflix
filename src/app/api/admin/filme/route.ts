export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isLegacyAdminTokenRequest, requireAdmin, requireAdminOrLegacyCatalogToken } from "@/lib/auth";
import { getMovieImages, pickLogo, pickBackdrop } from "@/lib/tmdb";
import { CATALOG_WRITE_MAQUINA, upsertCatalogMovie } from "@/lib/catalog-write";

// GET — lista filmes com busca
export async function GET(req: NextRequest) {
  const guard = await requireAdminOrLegacyCatalogToken(req); if (guard) return guard;

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
  const guard = await requireAdminOrLegacyCatalogToken(req); if (guard) return guard;

  const body = await req.json();
  const {
    id, tmdbId, titulo, tituloOriginal, poster, background,
    sinopse, ano, nota, duracao, urlDub, urlLeg, generos,
  } = body;

  if (!id || !titulo) return NextResponse.json({ error: "id e titulo obrigatórios" }, { status: 400 });

  // Busca imagens TMDB (logo + backdrop pt-BR) se tmdbId fornecido
  let logo: string | null = null;
  let backgroundPT: string | null = background ?? null;
  if (tmdbId) {
    const imgs = await getMovieImages(tmdbId).catch(() => null);
    logo = pickLogo(imgs) ?? null;
    // Usa backdrop pt-BR se disponível, caso contrário mantém o enviado
    const bd = pickBackdrop(imgs);
    if (bd) backgroundPT = bd;
  }

  const result = await upsertCatalogMovie({
    ...body,
    id: String(id),
    tmdbId: tmdbId ? String(tmdbId) : body.tmdbId,
    // Sem background no corpo e sem backdrop do TMDB, não apaga o atual.
    ...(backgroundPT !== null ? { background: backgroundPT } : {}),
    ...(logo ? { logo } : {}),
    generos,
  // Token legado = produtor máquina: null/"" não apagam o que já existe.
  }, undefined, isLegacyAdminTokenRequest(req) ? CATALOG_WRITE_MAQUINA : { emptyStringClears: true });
  return NextResponse.json({ ok: true, id: result.id });
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
