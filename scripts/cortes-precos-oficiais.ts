/**
 * Abre a venda do Cortes Start e do Cortes Pro com os preços OFICIAIS.
 *
 *   npx tsx scripts/cortes-precos-oficiais.ts --start=<centavos> --pro=<centavos> [--dias=30]
 *   ... --aplicar   grava (sem ele, só mostra o que faria)
 *
 * Nenhum valor tem padrão: preço é decisão comercial. Cortes AI é recusado até a
 * IA existir. Numa transação: cria o preço (ou reativa um igual já existente),
 * desativa os demais preços ativos do plano e ativa o plano. Os registros antigos
 * (inclusive os fictícios de teste) ficam, inativos.
 */
import { PrismaClient } from "@prisma/client";

export interface PrecoOficial { planoId: "cortes-start" | "cortes-pro"; precoCentavos: number; duracaoDias: number }

/** Lê e valida os argumentos. Lança com a mensagem do que falta. */
export function lerPrecosOficiais(argv: string[]): { precos: PrecoOficial[]; aplicar: boolean } {
  const arg = (nome: string) => argv.find((a) => a.startsWith(`--${nome}=`))?.split("=")[1];
  if (argv.some((a) => a.startsWith("--ai"))) throw new Error("Cortes AI não é comercializado até a IA existir.");
  const inteiro = (nome: string, valor: string | undefined, min: number, max: number) => {
    const n = Number(valor);
    if (!valor || !Number.isInteger(n) || n < min || n > max) throw new Error(`--${nome} obrigatório: inteiro entre ${min} e ${max}.`);
    return n;
  };
  const duracaoDias = arg("dias") === undefined ? 30 : inteiro("dias", arg("dias"), 1, 366);
  const precos: PrecoOficial[] = [
    { planoId: "cortes-start", precoCentavos: inteiro("start", arg("start"), 100, 100_000), duracaoDias },
    { planoId: "cortes-pro", precoCentavos: inteiro("pro", arg("pro"), 100, 100_000), duracaoDias },
  ];
  if (precos[1].precoCentavos <= precos[0].precoCentavos) throw new Error("O Pro (com lote) precisa custar mais que o Start.");
  return { precos, aplicar: argv.includes("--aplicar") };
}

async function main() {
  const { precos, aplicar } = lerPrecosOficiais(process.argv.slice(2));
  const rotulo = (dias: number) => (dias === 30 ? "30 dias" : `${dias} dias`);
  console.log(aplicar ? "APLICANDO:" : "SIMULAÇÃO (use --aplicar para gravar):");
  for (const p of precos) console.log(`  ${p.planoId}: R$ ${(p.precoCentavos / 100).toFixed(2)} / ${rotulo(p.duracaoDias)}`);
  if (!aplicar) return;
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      for (const p of precos) {
        const igual = await tx.planoPreco.findFirst({ where: { planoId: p.planoId, precoCentavos: p.precoCentavos, duracaoDias: p.duracaoDias, moeda: "BRL", rotulo: rotulo(p.duracaoDias) } });
        const preco = igual
          ? await tx.planoPreco.update({ where: { id: igual.id }, data: { ativo: true } })
          : await tx.planoPreco.create({ data: { planoId: p.planoId, rotulo: rotulo(p.duracaoDias), precoCentavos: p.precoCentavos, duracaoDias: p.duracaoDias, moeda: "BRL", ativo: true } });
        await tx.planoPreco.updateMany({ where: { planoId: p.planoId, ativo: true, id: { not: preco.id } }, data: { ativo: false } });
        await tx.plano.update({ where: { id: p.planoId }, data: { ativo: true } });
      }
    });
    console.log("Feito. Cortes AI continua inativo.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/cortes-precos-oficiais.ts")) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
