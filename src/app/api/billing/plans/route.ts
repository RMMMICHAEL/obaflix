import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { vitrineDoPlano } from "@/lib/billing/vitrine";
import { TELAS_ADICIONAIS_MAX } from "@/lib/billing/precificacao";

export const dynamic = "force-dynamic";

/**
 * Catálogo comercial público, deliberadamente sem qualquer dado do gateway.
 *
 * Fonte única da vitrine para TV, `/planos` e checkout: preços das linhas ativas
 * de `PlanoPreco` (dias ou meses de calendário), preço mensal da tela adicional
 * de `PlanoAdicionalPreco`, e benefícios derivados dos direitos de `Plano`.
 *
 * O preço do servidor VIP avulso **não** sai daqui: a oferta segue desligada até
 * ser liberada. Clientes antigos ignoram campos novos.
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
        id: true, rotulo: true, duracaoDias: true, duracaoMeses: true, precoCentavos: true, moeda: true,
      } },
      adicionais: { where: { ativo: true, tipo: "tela", moeda: "BRL" }, select: { precoMensalCentavos: true } },
    },
  });
  return NextResponse.json({
    planos: planos.map((linha: any) => {
      const { adicionais, ...plano } = linha;
      const tela = Array.isArray(adicionais) && adicionais.length > 0 ? adicionais[0].precoMensalCentavos : null;
      const vitrine = vitrineDoPlano({ ...plano, telasAdicionaisDisponiveis: tela !== null });
      return {
        ...plano,
        nome: vitrine.nome,
        vitrine,
        adicionais: { telaMensalCentavos: tela, telasAdicionaisMax: tela !== null ? TELAS_ADICIONAIS_MAX : 0 },
        compravel: plano.precos.length > 0,
      };
    }),
  }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createPlansHandler(), { createForTest: createPlansHandler });
