/**
 * seed-planos.ts — cria (ou atualiza) o plano padrão.
 *
 * Uso:
 *   npm run seed:planos            # mostra o que faria, não grava
 *   npm run seed:planos -- --apply # grava
 *
 * Executado à mão, nunca automaticamente pela migration. É o padrão dos outros
 * scripts do projeto, e evita seed rodando contra o banco errado por acidente —
 * `prisma migrate deploy` roda em CI e em produção, este script não.
 *
 * Idempotente por `upsert` no id: rodar dez vezes deixa uma linha. E o dry-run
 * é o default de propósito — o caminho mais fácil não deve ser o que escreve.
 *
 * O que ele NÃO faz, e não deve passar a fazer sem decisão explícita:
 *
 *   - não cria Básico, Plus nem Premium. Esses têm preço real e entram quando a
 *     matriz comercial estiver fechada.
 *   - não cria nenhuma linha de `Assinatura`. Nenhuma conta é tocada.
 *   - não restringe nada. Os valores em `PLANO_GRATUITO` reproduzem o
 *     comportamento de hoje, e é assim que a Fase 1 não muda nada para ninguém.
 */

import { PrismaClient } from "@prisma/client";
import { PLANO_GRATUITO, dadosDoUpsert } from "../src/lib/planos";
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient({ log: ["error"] });

const aplicar = process.argv.includes("--apply");

async function main() {
  const { id, ...campos } = PLANO_GRATUITO;

  const atual = await prisma.plano.findUnique({ where: { id } });

  console.log(`\nPlano "${id}"`);
  console.log(atual ? "  já existe — seria atualizado" : "  não existe — seria criado");
  for (const [chave, valor] of Object.entries(campos)) {
    const antes = atual ? (atual as Record<string, unknown>)[chave] : undefined;
    const mudou = atual && String(antes) !== String(valor);
    console.log(`  ${chave.padEnd(22)} ${String(valor)}${mudou ? `   (era ${String(antes)})` : ""}`);
  }

  if (!aplicar) {
    console.log("\nDry-run. Nada foi gravado. Use --apply para gravar.\n");
    return;
  }

  // `update` completo em vez de parcial: o plano padrão precisa terminar
  // exatamente igual à constante, mesmo que alguém tenha editado uma coluna à
  // mão no Studio. Se a intenção for restringir o gratuito de verdade, o lugar
  // é a constante — daí o seed vira a forma de aplicar, e não de desfazer.
  const salvo = await prisma.plano.upsert(dadosDoUpsert(PLANO_GRATUITO));

  const assinaturas = await prisma.assinatura.count();
  console.log(`\nGravado. ehPadrao=${salvo.ehPadrao} telasMax=${salvo.telasMax}`);
  console.log(`Assinaturas no banco: ${assinaturas} (esta fase não cria nenhuma)\n`);
}

main()
  .catch((erro) => {
    console.error("seed-planos falhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
