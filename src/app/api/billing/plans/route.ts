import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { vitrineDoPlano } from "@/lib/billing/vitrine";

export const dynamic = "force-dynamic";

/**
 * Catálogo comercial público, deliberadamente sem qualquer dado do gateway.
 *
 * É a fonte única da vitrine para TV, `/planos` e checkout: preços das linhas
 * ativas de `PlanoPreco` e benefícios derivados dos direitos de `Plano`
 * (`vitrineDoPlano`). `nome` sai com o nome público; `vitrine` é campo novo,
 * ignorado por clientes antigos.
 */
function createPlansHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma;
  return async function GET() {
  const planos = await banco.plano.findMany({
    where: { ativo: true }, orderBy: { ordem: "asc" },
    select: {
      id: true, nome: true, descricao: true, ehPadrao: true,
      filmes: true, series: true, downloads: true, telasMax: true,
      anunciosObrigatorios: true, canaisNivel: true, resolucaoMax: true,
      precos: { where: { ativo: true }, orderBy: { ordem: "asc" }, select: {
        id: true, rotulo: true, duracaoDias: true, precoCentavos: true, moeda: true,
      } },
    },
  });
  return NextResponse.json({
    planos: planos.map((plano: any) => {
      const vitrine = vitrineDoPlano(plano);
      return { ...plano, nome: vitrine.nome, vitrine, compravel: plano.precos.length > 0 };
    }),
  }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createPlansHandler(), { createForTest: createPlansHandler });
