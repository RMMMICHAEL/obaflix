/**
 * ajustar-plano-gratuito.ts — aplica a decisão comercial à linha `gratuito`
 * que **já existe** no banco.
 *
 * Uso:
 *   npm run planos:gratuito          # dry-run: mostra antes/depois, não grava
 *   npm run planos:gratuito:apply    # grava
 *
 * ## Por que um script separado, e não o seed
 *
 * `seed-planos.ts` **cria se faltar e nunca sobrescreve**, e é essa garantia que
 * o torna seguro de rodar a qualquer momento: ninguém desliga a monetização por
 * acidente rodando um comando chamado "seed". Colocar um caminho de sobrescrita
 * lá dentro destruiria exatamente isso.
 *
 * Então a sobrescrita mora aqui, com nome que diz o que faz, um alvo só e
 * `--apply` obrigatório. É o "fluxo próprio" que a documentação do seed sempre
 * mencionou.
 *
 * ## O que ele faz, e só
 *
 * `UPDATE "Plano" SET <direitos> WHERE id = 'gratuito'`. Uma linha, os campos de
 * direito, mais nada:
 *
 *   - não toca em `id`, `ehPadrao` nem `ativo` — mudar `ehPadrao` aqui poderia
 *     deixar o sistema sem plano padrão, e não é disso que este script trata;
 *   - não toca em nenhum outro plano, inclusive `interno-maximo`;
 *   - não cria, altera nem apaga `Assinatura`, `PlanoPreco` ou `Canal`;
 *   - recusa se o resultado ainda deixasse o gratuito acima de um plano pago —
 *     seria trocar uma incoerência por outra.
 *
 * ## O efeito é diferido, e o script diz isso
 *
 * Com `MONETIZACAO_ATIVA` desligada, gravar esta linha **não muda nada** para
 * ninguém: `autorizarCatalogo`, `limiteDeTelas` e `direitosDoCliente` devolvem o
 * comportamento antigo antes de consultar o banco. O efeito aparece quando a
 * flag for ligada — e aí é imediato, para toda conta sem assinatura ativa.
 * Por isso o relatório abaixo conta quantas contas são.
 */

import { PrismaClient } from "@prisma/client";
import {
  PLANO_GRATUITO,
  inversoesDeDireito,
  planoDaLinhaCrua,
  type DireitosDoPlano,
} from "../src/lib/planos";
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient({ log: ["error"] });
const aplicar = process.argv.includes("--apply");

/** Só os campos de direito. `id`, `nome`, `ordem`, `ativo` e `ehPadrao` ficam fora. */
const DIREITOS: DireitosDoPlano = {
  anunciosObrigatorios: PLANO_GRATUITO.anunciosObrigatorios,
  episodiosPorAnuncio: PLANO_GRATUITO.episodiosPorAnuncio,
  janelaAnuncioHoras: PLANO_GRATUITO.janelaAnuncioHoras,
  filmes: PLANO_GRATUITO.filmes,
  series: PLANO_GRATUITO.series,
  canaisNivel: PLANO_GRATUITO.canaisNivel,
  downloads: PLANO_GRATUITO.downloads,
  telasMax: PLANO_GRATUITO.telasMax,
  perfisMax: PLANO_GRATUITO.perfisMax,
  resolucaoMax: PLANO_GRATUITO.resolucaoMax,
  tvNivel: PLANO_GRATUITO.tvNivel,
};

async function main() {
  const linha = await prisma.plano.findUnique({ where: { id: PLANO_GRATUITO.id } });

  if (!linha) {
    console.log(
      `\nA linha "${PLANO_GRATUITO.id}" não existe. Este script ajusta uma linha\n` +
      "existente; criar é com `npm run seed:planos:apply`.\n",
    );
    process.exitCode = 1;
    return;
  }

  const atual = planoDaLinhaCrua(linha as unknown as Record<string, unknown>);
  if (!atual) {
    console.log(
      "\nA linha existe mas não pôde ser interpretada (coluna faltando, tipo\n" +
      "errado ou valor fora do domínio). Investigue antes de sobrescrever —\n" +
      "gravar por cima de um estado que não se consegue ler apaga a evidência.\n",
    );
    process.exitCode = 1;
    return;
  }

  // ── Antes e depois, campo a campo ─────────────────────────────────────────
  console.log(`\nPlano "${PLANO_GRATUITO.id}" — o que mudaria:\n`);
  const mudancas: string[] = [];
  for (const [campo, novo] of Object.entries(DIREITOS)) {
    const velho = (atual as unknown as Record<string, unknown>)[campo];
    const mudou = String(velho) !== String(novo);
    if (mudou) mudancas.push(campo);
    console.log(
      `  ${mudou ? "~" : " "} ${campo.padEnd(22)} ${String(velho).padEnd(10)} ${mudou ? "->" : "=="} ${String(novo)}`,
    );
  }

  if (!mudancas.length) {
    console.log("\nNada a fazer: a linha já está com os valores aprovados.\n");
    return;
  }

  // ── A checagem que impede trocar uma incoerência por outra ────────────────
  const restantes = inversoesDeDireito({ id: PLANO_GRATUITO.id, ...DIREITOS });
  if (restantes.length) {
    console.log("\n── RECUSADO ──────────────────────────────────────────────");
    console.log("Depois deste ajuste o gratuito AINDA entregaria mais que um plano pago:\n");
    for (const i of restantes) {
      console.log(`  ${i.planoPago.padEnd(8)} ${i.campo.padEnd(22)} gratuito=${String(i.noPadrao)} ${i.planoPago}=${String(i.noPago)}`);
    }
    console.log("\nNada foi gravado.\n");
    process.exitCode = 1;
    return;
  }

  // ── Quem sente, e quando ──────────────────────────────────────────────────
  const agora = new Date();
  const [contas, comAssinaturaAtiva] = await Promise.all([
    prisma.user.count(),
    prisma.assinatura.count({
      where: { status: "ATIVA", iniciaEm: { lte: agora }, terminaEm: { gt: agora } },
    }),
  ]);
  const flagLigada = process.env.MONETIZACAO_ATIVA === "true";

  console.log(`\nCampos que mudam: ${mudancas.join(", ")}`);
  console.log(`Contas no banco: ${contas} — com assinatura ativa: ${comAssinaturaAtiva}`);
  console.log(`Contas que passam a resolver por este plano: ${contas - comAssinaturaAtiva}`);
  console.log(`MONETIZACAO_ATIVA neste ambiente: ${flagLigada ? "LIGADA" : "desligada"}`);
  console.log(
    flagLigada
      ? "\n⚠  A flag está LIGADA: o efeito é IMEDIATO para as contas acima."
      : "\nCom a flag desligada, gravar isto NÃO muda nada para ninguém agora.\n" +
        "O efeito chega quando MONETIZACAO_ATIVA for ligada.",
  );

  if (!aplicar) {
    console.log("\nDry-run. Nada foi gravado. Use --apply para gravar.\n");
    return;
  }

  await prisma.plano.update({ where: { id: PLANO_GRATUITO.id }, data: DIREITOS });
  console.log("\nGravado.");

  // Reler e reconferir: a confirmação vem do banco, não da nossa intenção.
  const depois = planoDaLinhaCrua(
    (await prisma.plano.findUnique({ where: { id: PLANO_GRATUITO.id } })) as unknown as Record<string, unknown>,
  );
  const conferido = depois && inversoesDeDireito(depois).length === 0;
  console.log(
    conferido
      ? "Reconferido no banco: nenhuma inversão. `seed:planos:apply` está liberado.\n"
      : "ATENÇÃO: a releitura ainda acusa inversão. Investigue antes de seguir.\n",
  );
  if (!conferido) process.exitCode = 1;
}

main()
  .catch((erro) => {
    console.error("ajustar-plano-gratuito falhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
