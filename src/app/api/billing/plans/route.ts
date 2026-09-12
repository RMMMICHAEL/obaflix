import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Catálogo comercial público, deliberadamente sem qualquer dado do gateway. */
export async function GET() {
  const planos = await prisma.plano.findMany({
    where: { ativo: true }, orderBy: { ordem: "asc" },
    select: {
      id: true, nome: true, descricao: true, ehPadrao: true,
      filmes: true, series: true, downloads: true, telasMax: true,
      anunciosObrigatorios: true,
      precos: { where: { ativo: true }, orderBy: { ordem: "asc" }, select: {
        id: true, rotulo: true, duracaoDias: true, precoCentavos: true, moeda: true,
      } },
    },
  });
  return NextResponse.json({ planos }, { headers: { "Cache-Control": "no-store" } });
}
