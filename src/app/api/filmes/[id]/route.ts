export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });
  if (!filme) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  return NextResponse.json(publicMedia(filme));
}
