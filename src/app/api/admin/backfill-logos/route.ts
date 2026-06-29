export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getMovieImages, getTVImages, pickLogo, pickBackdrop } from "@/lib/tmdb";

const BATCH = 10;

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const { tipo = "all", limit = 200, mode = "all" } = await req.json().catch(() => ({}));
  // mode: "all" | "logos" | "backdrops"

  let filmedone = 0, seriedone = 0, erros = 0;

  // ── Filmes ──────────────────────────────────────────────────────────────
  if (tipo === "all" || tipo === "filmes") {
    const filmes = await prisma.filme.findMany({
      where: { tmdbId: { not: null } },
      select: { id: true, tmdbId: true },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    for (let i = 0; i < filmes.length; i += BATCH) {
      const batch = filmes.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (f) => {
          try {
            const imgs = await getMovieImages(f.tmdbId!);
            const data: Record<string, string> = {};
            if (mode === "all" || mode === "logos") {
              const logoPath = pickLogo(imgs);
              if (logoPath) data.logo = logoPath;
            }
            if (mode === "all" || mode === "backdrops") {
              const bd = pickBackdrop(imgs);
              if (bd) data.background = bd;
            }
            if (Object.keys(data).length > 0) {
              await prisma.filme.update({ where: { id: f.id }, data });
              filmedone++;
            }
          } catch {
            erros++;
          }
        })
      );
    }
  }

  // ── Séries / Animes / Desenhos ──────────────────────────────────────────
  if (tipo === "all" || tipo === "series") {
    const series = await prisma.serie.findMany({
      where: { tmdbId: { not: null } },
      select: { id: true, tmdbId: true },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    for (let i = 0; i < series.length; i += BATCH) {
      const batch = series.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (s) => {
          try {
            const imgs = await getTVImages(s.tmdbId!);
            const data: Record<string, string> = {};
            if (mode === "all" || mode === "logos") {
              const logoPath = pickLogo(imgs);
              if (logoPath) data.logo = logoPath;
            }
            if (mode === "all" || mode === "backdrops") {
              const bd = pickBackdrop(imgs);
              if (bd) data.background = bd;
            }
            if (Object.keys(data).length > 0) {
              await prisma.serie.update({ where: { id: s.id }, data });
              seriedone++;
            }
          } catch {
            erros++;
          }
        })
      );
    }
  }

  return NextResponse.json({
    ok: true,
    filmes: filmedone,
    series: seriedone,
    erros,
    mensagem: `Imagens atualizadas — ${filmedone} filmes, ${seriedone} séries, ${erros} erros`,
  });
}
