export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
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
      include: { generos: { include: { genero: true } } },
    }),
    prisma.filme.count({ where }),
  ]);

  return NextResponse.json({ filmes, total, page, pages: Math.ceil(total / limit) });
}
