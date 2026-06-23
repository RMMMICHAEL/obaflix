import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
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
      include: { generos: { include: { genero: true } } },
    }),
    prisma.serie.count({ where }),
  ]);

  return NextResponse.json({ series, total, page, pages: Math.ceil(total / limit) });
}
