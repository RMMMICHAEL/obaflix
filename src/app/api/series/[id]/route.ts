export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });
  if (!serie) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  return NextResponse.json(serie);
}
