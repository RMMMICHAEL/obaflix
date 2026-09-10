/**
 * seed-planos.ts — cria o plano padrão, se ele ainda não existir.
 *
 * Uso:
 *   npm run seed:planos            # mostra o que faria, não grava
 *   npm run seed:planos:apply      # grava, se a linha não existir
 *
 * Executado à mão, nunca automaticamente pela migration. É o padrão dos outros
 * scripts do projeto, e evita seed rodando contra o banco errado por acidente.
 *
 * ## Cria se faltar; nunca sobrescreve
 *
 * `PLANO_GRATUITO` é **bootstrap**, não configuração permanente. Depois que a
 * linha existe, o **Postgres é a fonte de verdade** — inclusive, e sobretudo,
 * quando alguém já ajustou os direitos por decisão comercial.
 *
 * Rodar `--apply` com o plano já existente não altera nenhum direito: informa o
 * que encontrou, aponta o que difere da fotografia, e encerra com sucesso.
 *
 * ## O que ele NÃO faz, e não deve passar a fazer
 *
 *   - não sobrescreve plano existente, nem com `--force`. Uma flag que devolve
 *     o comportamento perigoso reintroduz o risco com um passo a mais, e um
 *     passo a mais não é uma barreira. Alteração comercial tem fluxo próprio.
 *   - não cria Básico, Plus nem Premium. Esses têm preço real e entram quando a
 *     matriz comercial estiver fechada.
 *   - não cria nenhuma linha de `Assinatura`. Nenhuma conta é tocada.
 */

import { PrismaClient } from "@prisma/client";
import {
  PLANO_GRATUITO,
  diferencas,
  semearPlanoPadrao,
  type RepositorioDePlanos,
} from "../src/lib/planos";
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient({ log: ["error"] });

const aplicar = process.argv.includes("--apply");

/** O repositório real. Nos testes entra um equivalente em memória. */
const repositorio: RepositorioDePlanos = {
  buscar: (id) => prisma.plano.findUnique({ where: { id } }) as Promise<Record<string, unknown> | null>,
  criar: async (plano) => { await prisma.plano.create({ data: plano }); },
};

async function main() {
  const existente = await repositorio.buscar(PLANO_GRATUITO.id);

  if (existente) {
    const divergentes = diferencas(existente);
    console.log(`\nPlano "${PLANO_GRATUITO.id}" já existe. Nada a fazer.`);
    if (divergentes.length) {
      console.log("\nDireitos que o banco tem diferentes da fotografia inicial:");
      for (const d of divergentes) {
        console.log(`  ${d.campo.padEnd(22)} banco=${String(d.noBanco).padEnd(10)} fotografia=${String(d.naFotografia)}`);
      }
      console.log("\nO seed NÃO altera nenhum deles — o banco é a fonte de verdade.");
    }
    console.log();
    return;
  }

  console.log(`\nPlano "${PLANO_GRATUITO.id}" não existe. Seria criado com:`);
  for (const [campo, valor] of Object.entries(PLANO_GRATUITO)) {
    if (campo === "id") continue;
    console.log(`  ${campo.padEnd(22)} ${String(valor)}`);
  }

  if (!aplicar) {
    console.log("\nDry-run. Nada foi gravado. Use --apply para gravar.\n");
    return;
  }

  const resultado = await semearPlanoPadrao(repositorio);
  const assinaturas = await prisma.assinatura.count();

  console.log(`\n${resultado.acao === "criado" ? "Criado." : "Já existia; mantido."}`);
  console.log(`Assinaturas no banco: ${assinaturas} (esta fase não cria nenhuma)\n`);
}

main()
  .catch((erro) => {
    console.error("seed-planos falhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
