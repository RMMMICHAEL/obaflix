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
    const limit = 24;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (genero) where.generos = { some: { generoId: Number(genero) } };
    if (ano) where.ano = Number(ano);

    const orderBy: any =
      ordem === "nota" ? { nota: "desc" }
      : ordem === "az" ? { titulo: "asc" }
      : { createdAt: "desc" };

    const [filmes, total] = await Promise.all([
      prisma.filme.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select: {
          id: true, titulo: true, poster: true, background: true,
          sinopse: true, ano: true, nota: true, urlDub: true, urlLeg: true,
          generos: { select: { genero: { select: { id: true, nome: true } } } },
        },
      }),
      prisma.filme.count({ where }),
    ]);

    return NextResponse.json({ filmes, total, page, pages: Math.ceil(total / limit) });
  } catch (e: any) {
    console.error("GET /api/filmes error:", e?.message);
    return NextResponse.json({ error: "Erro ao buscar filmes", filmes: [], total: 0, page: 1, pages: 0 }, { status: 500 });
  }
}
