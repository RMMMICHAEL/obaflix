import { serieDisponivel } from "@/lib/catalog-availability";
import { BRAZIL_SERIES_BROWSE_LIMIT, getBrazilSeriesRanking, paginateBrazilSeriesRows } from "@/lib/brazil-series-ranking";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const page = Number(searchParams.get("page") ?? 1);
    const genero = searchParams.get("genero");
    const ano = searchParams.get("ano");
    const ordem = searchParams.get("ordem") ?? "recente";
    const tipo = searchParams.get("tipo");
    const q = searchParams.get("q");
    const limit = 24;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (tipo) where.tipo = tipo;
    if (genero) where.generos = { some: { generoId: Number(genero) } };
    if (ano) where.ano = Number(ano);
    if (q) where.titulo = { contains: q, mode: "insensitive" };
    // Popularidade de séries = Brasil; anime/desenho explícitos mantêm TMDB.
    const brazilIds = ordem === "popular" && (!tipo || tipo === "serie")
      ? await getBrazilSeriesRanking("week", BRAZIL_SERIES_BROWSE_LIMIT) : null;
    if (brazilIds) { where.tipo = "serie"; where.id = { in: brazilIds }; }

    const orderBy: any =
      ordem === "nota"       ? { scoreDestaque: { sort: "desc", nulls: "last" } }
      : ordem === "popular"   ? { popularidade: { sort: "desc", nulls: "last" } }
      : ordem === "lancamento" ? [{ ano: "desc" }, { createdAt: "desc" }]
      : ordem === "az"        ? { titulo: "asc" }
      : ordem === "antigo"    ? { createdAt: "asc" }
      : { createdAt: "desc" };

    const [rawSeries, rawTotal] = await Promise.all([
      prisma.serie.findMany({
        where: serieDisponivel(where),
        orderBy: brazilIds ? undefined : orderBy,
        skip: brazilIds ? undefined : skip,
        take: brazilIds ? undefined : limit,
        select: {
          id: true, titulo: true, poster: true, background: true, logo: true,
          sinopse: true, ano: true, nota: true, tipo: true,
          generos: { select: { genero: { select: { id: true, nome: true } } } },
        },
      }),
      brazilIds ? Promise.resolve(0) : prisma.serie.count({ where: serieDisponivel(where) }),
    ]);
    const { series, total } = brazilIds
      ? paginateBrazilSeriesRows(brazilIds, rawSeries, page, limit)
      : { series: rawSeries, total: rawTotal };

    return NextResponse.json({ series, total, page, pages: Math.ceil(total / limit) });
  } catch (e: any) {
    console.error("GET /api/series error:", e?.message);
    return NextResponse.json({ error: "Erro ao buscar séries", series: [], total: 0, page: 1, pages: 0 }, { status: 500 });
  }
}
