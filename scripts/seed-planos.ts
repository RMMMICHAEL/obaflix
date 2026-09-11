/**
 * seed-planos.ts — cria o plano padrão e a matriz comercial, se faltarem.
 *
 * Uso:
 *   npm run seed:planos            # mostra o que faria, não grava
 *   npm run seed:planos:apply      # grava as linhas que não existirem
 *
 * Executado à mão, nunca automaticamente pela migration. É o padrão dos outros
 * scripts do projeto, e evita seed rodando contra o banco errado por acidente.
 *
 * ## Cria se faltar; nunca sobrescreve
 *
 * As constantes de `src/lib/planos.ts` são **bootstrap**, não configuração
 * permanente. Depois que a linha existe, o **Postgres é a fonte de verdade** —
 * inclusive, e sobretudo, quando alguém já ajustou os direitos por decisão
 * comercial.
 *
 * Rodar `--apply` com um plano já existente não altera nenhum direito dele:
 * informa o que encontrou, aponta o que difere da fotografia, e segue.
 *
 * ## O que ele NÃO faz, e não deve passar a fazer
 *
 *   - não sobrescreve plano existente, nem com `--force`. Uma flag que devolve
 *     o comportamento perigoso reintroduz o risco com um passo a mais, e um
 *     passo a mais não é uma barreira. Alteração comercial tem fluxo próprio.
 *   - **não cria nenhuma linha de `PlanoPreco`.** Basic, Plus e Premium nascem
 *     sem preço e, portanto, não compráveis: `resolverPreco` recusa com
 *     `preco_inexistente`. Os valores comerciais entram por fluxo próprio,
 *     quando existirem. Semear preço fictício para "destravar" o checkout seria
 *     inventar número que alguém acabaria cobrando.
 *   - não cria nenhuma linha de `Assinatura`. Nenhuma conta é tocada.
 *   - não mexe em `Canal`. A curadoria de `nivelMinimo` é outro fluxo, e este
 *     script não sabe nada sobre canais.
 *   - não mexe em `ehPadrao`. `gratuito` continua sendo o plano de quem não
 *     assina; os três comerciais nascem com `ehPadrao: false`.
 */

import { PrismaClient } from "@prisma/client";
import {
  PLANO_GRATUITO,
  PLANOS_COMERCIAIS,
  diferencas,
  inversoesDeDireito,
  semearPlanoPadrao,
  semearPlanosComerciais,
  type PlanoSemeado,
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

/**
 * Relata o estado de um plano, sem tocar em nada.
 *
 * Roda antes do `--apply` e também sem ele: o dry-run e a execução mostram a
 * mesma leitura, e a única diferença entre os dois é a gravação no fim.
 *
 * Devolve `true` quando a linha falta — é o que decide se há algo a fazer.
 */
async function relatar(plano: PlanoSemeado): Promise<boolean> {
  const existente = await repositorio.buscar(plano.id);

  if (existente) {
    console.log(`\n"${plano.id}" já existe. Não será alterado.`);
    const divergentes = diferencas(existente, plano);
    if (divergentes.length) {
      console.log("  Direitos que o banco tem diferentes da fotografia deste arquivo:");
      for (const d of divergentes) {
        console.log(
          `    ${d.campo.padEnd(22)} banco=${String(d.noBanco).padEnd(10)} fotografia=${String(d.naFotografia)}`,
        );
      }
      console.log("  O seed NÃO altera nenhum deles — o banco é a fonte de verdade.");
    }
    return false;
  }

  console.log(`\n"${plano.id}" não existe. Seria criado com:`);
  for (const [campo, valor] of Object.entries(plano)) {
    if (campo === "id") continue;
    console.log(`    ${campo.padEnd(22)} ${String(valor)}`);
  }
  return true;
}

async function main() {
  const todos = [PLANO_GRATUITO, ...PLANOS_COMERCIAIS];

  let faltando = 0;
  for (const plano of todos) {
    if (await relatar(plano)) faltando++;
  }

  if (faltando === 0) {
    console.log("\nNada a fazer: os quatro planos já existem.\n");
    return;
  }

  // ── Bloqueador comercial ──────────────────────────────────────────────────
  //
  // O gratuito atual entrega 5 telas, download e 4K; o Basic pago entrega 2
  // telas, sem download, em HD. Criar as linhas nesse estado colocaria à venda
  // um plano pior do que a conta já tem de graça.
  //
  // O script recusa o `--apply` enquanto a inversão existir. **A trava se levanta
  // sozinha**: no dia em que o gratuito for restringido por decisão comercial,
  // `inversoesDeDireito` devolve vazio e o apply passa. Não há flag para pular,
  // pelo mesmo motivo de não existir `--force` aqui.
  //
  // O dry-run continua mostrando tudo: ver o que seria criado não depende de a
  // matriz estar coerente, e é justamente o que ajuda a decidir.
  const inversoes = inversoesDeDireito(PLANO_GRATUITO);
  if (inversoes.length) {
    console.log("\n── BLOQUEADOR COMERCIAL ──────────────────────────────────");
    console.log("O plano padrão entrega MAIS que um plano pago nestes direitos:\n");
    for (const i of inversoes) {
      console.log(
        `  ${i.planoPago.padEnd(8)} ${i.campo.padEnd(22)} gratuito=${String(i.noPadrao).padEnd(8)} ${i.planoPago}=${String(i.noPago)}`,
      );
    }
    console.log(
      "\nVender um plano pago pior do que o gratuito é decisão que ninguém tomou.\n" +
      "Ajuste os direitos do plano `gratuito` no banco (decisão comercial, fluxo\n" +
      "próprio) e rode de novo — esta trava se levanta sozinha quando a inversão\n" +
      "deixar de existir.",
    );
    if (aplicar) {
      console.log("\n--apply RECUSADO. Nada foi gravado.\n");
      process.exitCode = 1;
      return;
    }
    console.log("\n(dry-run: a listagem acima continua valendo, mas --apply seria recusado)\n");
  }

  if (!aplicar) {
    console.log(`\nDry-run. Nada foi gravado (${faltando} a criar). Use --apply para gravar.\n`);
    return;
  }

  // O padrão primeiro: é ele que carrega a garantia de plano único com
  // `ehPadrao`, e falhar ali não deve deixar comerciais criados pela metade.
  const padrao = await semearPlanoPadrao(repositorio);
  const comerciais = await semearPlanosComerciais(repositorio);

  console.log("\nResultado:");
  for (const { plano, resultado } of [{ plano: PLANO_GRATUITO, resultado: padrao }, ...comerciais]) {
    console.log(`  ${plano.id.padEnd(10)} ${resultado.acao === "criado" ? "criado" : "já existia; mantido"}`);
  }

  // As três contagens que provam o que este script não fez. `PlanoPreco` é a
  // mais importante: enquanto ela for 0 para os comerciais, eles existem e não
  // são vendáveis — que é o estado pedido enquanto não há valores fechados.
  const [assinaturas, precos, precosComerciais] = await Promise.all([
    prisma.assinatura.count(),
    prisma.planoPreco.count(),
    prisma.planoPreco.count({ where: { planoId: { in: PLANOS_COMERCIAIS.map((p) => p.id) } } }),
  ]);

  console.log(`\nAssinaturas no banco: ${assinaturas} (este script não cria nenhuma)`);
  console.log(`Preços no banco: ${precos} — dos planos comerciais: ${precosComerciais}`);
  if (precosComerciais === 0) {
    console.log("Sem preço, os comerciais não são compráveis. É o estado esperado hoje.\n");
  } else {
    console.log("Atenção: já existe preço comercial cadastrado por outro fluxo.\n");
  }
}

main()
  .catch((erro) => {
    console.error("seed-planos falhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
