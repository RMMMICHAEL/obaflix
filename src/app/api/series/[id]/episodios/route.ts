export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const temporada = req.nextUrl.searchParams.get("temporada");

  const episodios = await prisma.episodio.findMany({
    where: {
      serieId: params.id,
      ...(temporada ? { temporada: Number(temporada) } : {}),
    },
    orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
  });

  return NextResponse.json(episodios.map(publicMedia));
}
