/**
 * precos-planos.ts — prepara os preços de 30 dias e os ajustes de plano.
 *
 * Uso:
 *   npm run precos:planos                                   # dry-run: só mostra
 *   npm run precos:planos -- --apply --banco=<host do DATABASE_URL>
 *
 * ## ATENÇÃO: Preview e Production usam o mesmo banco hoje
 *
 * `DATABASE_URL` está configurado para Production **e** Preview na Vercel.
 * Rodar `--apply` com essa URL grava em Production. Não rode sem autorização
 * explícita; o caminho previsto é um banco próprio de Preview.
 *
 * ## O que faz
 *
 *   - cria `PlanoPreco` de 30 dias (Básico R$ 10,00, Plus R$ 19,90,
 *     Premium R$ 29,90) onde não houver preço ativo de 30 dias;
 *   - ajusta `Plano.nome` do Básico e `Plano.resolucaoMax` do Plus.
 *
 * ## O que não faz
 *
 *   - não sobrescreve preço existente com outro valor (conflito recusa o apply);
 *   - não cria 5 meses nem 1 ano (dependem de schema — ver catalogoComercial.ts);
 *   - não cria assinatura, cupom, adicional, nem mexe em canais ou no gratuito.
 */

import { PrismaClient } from "@prisma/client";
import {
  PRECOS_PENDENTES_DE_SCHEMA,
  bancoConfirmado,
  planejarCatalogo,
  podeAplicar,
} from "../src/lib/billing/catalogoComercial";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- mesmo carregamento opcional de seed-planos.ts
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient({ log: ["error"] });

const aplicar = process.argv.includes("--apply");
const banco = process.argv.find((a) => a.startsWith("--banco="))?.slice("--banco=".length);

const reais = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main() {
  const [planos, precos] = await Promise.all([
    prisma.plano.findMany({ select: { id: true, nome: true, resolucaoMax: true } }),
    prisma.planoPreco.findMany({
      select: { planoId: true, duracaoDias: true, precoCentavos: true, moeda: true, ativo: true },
    }),
  ]);

  const acoes = planejarCatalogo({ planos, precos });

  console.log("\nPlano de alterações:");
  for (const a of acoes) {
    switch (a.tipo) {
      case "criar_preco":
        console.log(`  + ${a.planoId.padEnd(8)} preço ${a.rotulo}: ${reais(a.precoCentavos)}`);
        break;
      case "preco_ja_correto":
        console.log(`  = ${a.planoId.padEnd(8)} preço de 30 dias já correto`);
        break;
      case "conflito_de_preco":
        console.log(`  ! ${a.planoId.padEnd(8)} CONFLITO: ativo ${reais(a.existenteCentavos)}, esperado ${reais(a.esperadoCentavos)}`);
        break;
      case "plano_ausente":
        console.log(`  ! ${a.planoId.padEnd(8)} plano não existe — rode seed:planos antes`);
        break;
      case "atualizar_plano":
        console.log(`  ~ ${a.planoId.padEnd(8)} ${a.campo}: "${a.de}" → "${a.para}"`);
        break;
    }
  }

  console.log("\nAprovados e NÃO criados (dependem de duração em meses no schema):");
  for (const p of PRECOS_PENDENTES_DE_SCHEMA) {
    console.log(`  - ${p.planoId.padEnd(8)} ${p.meses === 12 ? "1 ano" : "5 meses"}: ${reais(p.precoCentavos)}`);
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
            planoId: a.planoId, rotulo: a.rotulo, duracaoDias: a.duracaoDias,
            precoCentavos: a.precoCentavos, moeda: a.moeda, ativo: true, ordem: 0,
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
