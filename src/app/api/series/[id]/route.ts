export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });
  if (!serie) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  return NextResponse.json(serie);
}
