import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { expandGenreIds, parseGenreIds } from "@/lib/genres";

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
    // `Number(genero)` virava NaN assim que o valor era a lista agrupada que o
    // FilterBar emite ("12,10759"). Agora a API le o mesmo formato das paginas
    // e expande as equivalencias filme/TV como elas fazem.
    const generoIds = expandGenreIds(parseGenreIds(genero));
    if (generoIds.length) where.generos = { some: { generoId: { in: generoIds } } };
    if (ano) where.ano = Number(ano);
    if (q) where.titulo = { contains: q, mode: "insensitive" };

    const orderBy: any =
      ordem === "nota"       ? { scoreDestaque: { sort: "desc", nulls: "last" } }
      : ordem === "popular"   ? { popularidade: { sort: "desc", nulls: "last" } }
      : ordem === "lancamento" ? [{ ano: "desc" }, { createdAt: "desc" }]
      : ordem === "az"        ? { titulo: "asc" }
      : ordem === "antigo"    ? { createdAt: "asc" }
      : { createdAt: "desc" };

    const [series, total] = await Promise.all([
      prisma.serie.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: {
          id: true, titulo: true, poster: true, background: true, logo: true,
          sinopse: true, ano: true, nota: true, tipo: true,
          generos: { select: { genero: { select: { id: true, nome: true } } } },
        },
      }),
      prisma.serie.count({ where }),
    ]);

    return NextResponse.json({ series, total, page, pages: Math.ceil(total / limit) });
  } catch (e: any) {
    console.error("GET /api/series error:", e?.message);
    return NextResponse.json({ error: "Erro ao buscar séries", series: [], total: 0, page: 1, pages: 0 }, { status: 500 });
  }
}
