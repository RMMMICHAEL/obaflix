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
    const limit = 24;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (tipo) where.tipo = tipo;
    if (genero) where.generos = { some: { generoId: Number(genero) } };
    if (ano) where.ano = Number(ano);

    const orderBy: any =
      ordem === "nota" ? { nota: "desc" }
      : ordem === "az" ? { titulo: "asc" }
      : { createdAt: "desc" };

    const [series, total] = await Promise.all([
      prisma.serie.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: {
          id: true, titulo: true, poster: true, ano: true,
          nota: true, tipo: true,
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
