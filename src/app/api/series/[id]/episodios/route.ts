import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const temporada = req.nextUrl.searchParams.get("temporada");

  const episodios = await prisma.episodio.findMany({
    where: {
      serieId: params.id,
      ...(temporada ? { temporada: Number(temporada) } : {}),
    },
    orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
  });

  return NextResponse.json(episodios);
}
