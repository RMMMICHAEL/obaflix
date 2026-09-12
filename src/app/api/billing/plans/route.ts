import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Catálogo comercial público, deliberadamente sem qualquer dado do gateway. */
function createPlansHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma;
  return async function GET() {
  const planos = await banco.plano.findMany({
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
  return NextResponse.json({ planos: planos.map((plano: any) => ({ ...plano, compravel: plano.precos.length > 0 })) }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createPlansHandler(), { createForTest: createPlansHandler });
