/**
 * seja-premium.ts — cadastra o plano "SEJA PREMIUM" (direitos do Gratuito, sem anúncios, R$ 10,00 / 30 dias).
 *
 * Uso:
 *   npm run plano:seja-premium                                   # dry-run: só mostra, não grava
 *   npm run plano:seja-premium -- --apply --banco=<host do DATABASE_URL>
 *
 * ## ATENÇÃO
 *
 * `--apply` grava no banco do `DATABASE_URL` em uso. Em Production exige autorização explícita; o host exato em
 * `--banco=` evita escrever sem saber onde. Sem migration: só insere uma linha em `Plano` e uma em `PlanoPreco`.
 *
 * ## O que faz
 *
 *   - lê a linha VIVA do plano `gratuito` e herda todos os direitos dela (telas, qualidade, download, canais...);
 *   - cria `seja-premium` com `anunciosObrigatorios = false`, `ordem = 0` (abaixo do Básico), `ehPadrao = false`;
 *   - cria o preço `preco-seja-premium-30d`: R$ 10,00, 30 dias, pagamento único.
 *
 * ## O que não faz
 *
 *   - não altera Gratuito, Básico, Plus, Premium nem preço nenhum; não cria assinatura;
 *   - não grava se o Gratuito não existir, se o preço existir diferente ou se o plano existir com direitos divergentes;
 *   - não o põe na vitrine: `PLANOS_FORA_DA_VITRINE` o esconde de `/planos` e da TV.
 */

import { PrismaClient } from "@prisma/client";
import { bancoConfirmado } from "../src/lib/billing/catalogoComercial";
import { PLANO_SEJA_PREMIUM_ID } from "../src/lib/billing/vitrine";
import { PRECO_SEJA_PREMIUM, planejarSejaPremium, podeAplicarSejaPremium } from "../src/lib/billing/sejaPremium";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- mesmo carregamento opcional dos outros scripts
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient({ log: ["error"] });
const aplicar = process.argv.includes("--apply");
const banco = process.argv.find((a) => a.startsWith("--banco="))?.slice("--banco=".length);

async function main() {
  const [gratuito, plano, preco] = await Promise.all([
    prisma.plano.findUnique({ where: { id: "gratuito" } }),
    prisma.plano.findUnique({ where: { id: PLANO_SEJA_PREMIUM_ID } }),
    prisma.planoPreco.findUnique({ where: { id: PRECO_SEJA_PREMIUM.id } }),
  ]);
  const acoes = planejarSejaPremium({ gratuito: gratuito as any, plano: plano as any, preco: preco as any });

  console.log("\nPlano de alterações:");
  for (const a of acoes) console.log("  " + JSON.stringify(a));

  if (!podeAplicarSejaPremium(acoes)) {
    console.log("\nRecusado: há conflito ou falta o Gratuito. Nada será gravado.\n");
    process.exitCode = 1;
    return;
  }
  if (!aplicar) {
    console.log("\nDry-run: nada foi gravado. Use --apply --banco=<host> para gravar.\n");
    return;
  }
  if (!bancoConfirmado(process.env.DATABASE_URL, banco)) {
    console.log("\nRecusado: --banco= não confere com o host do DATABASE_URL.\n");
    process.exitCode = 1;
    return;
  }
  await prisma.$transaction(async (tx) => {
    for (const a of acoes) {
      if (a.tipo === "criar_plano") await tx.plano.create({ data: a.dados as any });
      if (a.tipo === "criar_preco") await tx.planoPreco.create({ data: a.dados as any });
    }
  });
  console.log("\nGravado.\n");
}

main().finally(() => prisma.$disconnect());
