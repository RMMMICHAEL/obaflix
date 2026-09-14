/**
 * precos-planos.ts — prepara preços por duração, adicionais e ajustes de plano.
 *
 * Uso:
 *   npm run precos:planos                                   # dry-run: só mostra
 *   npm run precos:planos -- --apply --banco=<host do DATABASE_URL>
 *
 * ## ATENÇÃO: Preview e Production usam o mesmo banco hoje
 *
 * `DATABASE_URL` está configurado para Production **e** Preview na Vercel.
 * Rodar `--apply` com essa URL grava em Production. Não rode sem autorização
 * explícita; o caminho previsto é um banco próprio de Preview, **depois** de
 * aplicada a migration 20260913_duracoes_adicionais_vip.
 *
 * ## O que faz
 *
 *   - cria `PlanoPreco` de 30 dias, 5 meses e 1 ano para Básico, Plus e Premium;
 *   - cria `PlanoAdicionalPreco` de tela (Básico R$ 10,00, Plus R$ 9,95,
 *     Premium R$ 14,95 por mês) e de VIP avulso do Básico (R$ 5,90/mês, inativo);
 *   - ajusta `nome` do Básico, `resolucaoMax` do Plus e `servidorVip` de Plus e
 *     Premium.
 *
 * ## O que não faz
 *
 *   - não sobrescreve valor existente diferente (conflito recusa o apply);
 *   - não cria assinatura, cupom, nem mexe em canais ou no gratuito.
 */

import { PrismaClient } from "@prisma/client";
import { bancoConfirmado, planejarCatalogo, podeAplicar } from "../src/lib/billing/catalogoComercial";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- mesmo carregamento opcional de seed-planos.ts
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient({ log: ["error"] });

const aplicar = process.argv.includes("--apply");
const banco = process.argv.find((a) => a.startsWith("--banco="))?.slice("--banco=".length);

const reais = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main() {
  const [planos, precos, adicionais] = await Promise.all([
    prisma.plano.findMany({ select: { id: true, nome: true, resolucaoMax: true, servidorVip: true } }),
    prisma.planoPreco.findMany({
      select: { planoId: true, duracaoDias: true, duracaoMeses: true, precoCentavos: true, moeda: true, ativo: true },
    }),
    prisma.planoAdicionalPreco.findMany({
      select: { planoId: true, tipo: true, precoMensalCentavos: true, moeda: true, ativo: true },
    }),
  ]);

  const acoes = planejarCatalogo({ planos, precos, adicionais });

  console.log("\nPlano de alterações:");
  for (const a of acoes) {
    switch (a.tipo) {
      case "criar_preco":
        console.log(`  + ${a.planoId.padEnd(8)} preço ${a.rotulo}: ${reais(a.precoCentavos)}`);
        break;
      case "preco_ja_correto":
        console.log(`  = ${a.planoId.padEnd(8)} preço ${a.rotulo} já correto`);
        break;
      case "conflito_de_preco":
        console.log(`  ! ${a.planoId.padEnd(8)} CONFLITO ${a.rotulo}: ativo ${reais(a.existenteCentavos)}, esperado ${reais(a.esperadoCentavos)}`);
        break;
      case "criar_adicional":
        console.log(`  + ${a.planoId.padEnd(8)} ${a.adicional}: ${reais(a.precoMensalCentavos)}/mês${a.ativo ? "" : " (inativo)"}`);
        break;
      case "adicional_ja_existe":
        console.log(`  = ${a.planoId.padEnd(8)} ${a.adicional} já cadastrado`);
        break;
      case "conflito_de_adicional":
        console.log(`  ! ${a.planoId.padEnd(8)} CONFLITO ${a.adicional}: ativo ${reais(a.existenteCentavos)}, esperado ${reais(a.esperadoCentavos)}`);
        break;
      case "plano_ausente":
        console.log(`  ! ${a.planoId.padEnd(8)} plano não existe — rode seed:planos antes`);
        break;
      case "atualizar_plano":
        console.log(`  ~ ${a.planoId.padEnd(8)} ${a.campo}: ${JSON.stringify(a.de)} → ${JSON.stringify(a.para)}`);
        break;
    }
  }

  if (!aplicar) {
    console.log("\nDry-run. Nada foi gravado.\n");
    return;
  }
  if (!bancoConfirmado(process.env.DATABASE_URL, banco)) {
    console.log("\n--apply RECUSADO: informe --banco=<host exato do DATABASE_URL>. Nada foi gravado.\n");
    process.exitCode = 1;
    return;
  }
  if (!podeAplicar(acoes)) {
    console.log("\n--apply RECUSADO: há conflito ou plano ausente. Nada foi gravado.\n");
    process.exitCode = 1;
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const a of acoes) {
      if (a.tipo === "criar_preco") {
        await tx.planoPreco.create({
          data: {
            planoId: a.planoId, rotulo: a.rotulo, duracaoDias: a.duracaoDias, duracaoMeses: a.duracaoMeses,
            precoCentavos: a.precoCentavos, moeda: a.moeda, ativo: true, ordem: a.ordem,
          },
        });
      } else if (a.tipo === "criar_adicional") {
        await tx.planoAdicionalPreco.create({
          data: {
            planoId: a.planoId, tipo: a.adicional, precoMensalCentavos: a.precoMensalCentavos,
            moeda: a.moeda, ativo: a.ativo,
          },
        });
      } else if (a.tipo === "atualizar_plano") {
        await tx.plano.update({ where: { id: a.planoId }, data: { [a.campo]: a.para } });
      }
    }
  });

  console.log("\nAplicado.\n");
}

main()
  .catch((erro) => {
    console.error("precos-planos falhou:", erro instanceof Error ? erro.message : "erro");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
