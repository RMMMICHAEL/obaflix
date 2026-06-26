/**
 * Remove episódios duplicados (mesmo serieId + temporada + numeroEp, IDs diferentes).
 * Mantém o que tem mais dados: thumbnail > múltiplos players > id numérico (import original).
 * Uso: npx tsx scripts/cleanup-eps-dupes.ts [--dry-run]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry-run");

function score(ep: any): number {
  let s = 0;
  if (ep.thumbnail) s += 100;
  if (ep.urlDub && ep.urlDub.includes(",")) s += 50; // múltiplos players
  if (ep.urlDub) s += 10;
  if (ep.urlLeg) s += 5;
  if (ep.titulo && ep.titulo !== `Episódio ${ep.numeroEp}`) s += 20; // título real
  // IDs numéricos puros = import original (preferir)
  if (/^\d+$/.test(ep.id)) s += 30;
  return s;
}

async function main() {
  console.log(`\n🧹 Cleanup de episódios duplicados — ${DRY ? "DRY RUN" : "REAL"}\n`);

  // Busca grupos com mesmo serieId+temporada+numeroEp duplicados
  const dupes = await prisma.$queryRaw<Array<{serieId: string, temporada: number, numeroEp: number, cnt: bigint}>>`
    SELECT "serieId", temporada, "numeroEp", COUNT(*) as cnt
    FROM "Episodio"
    GROUP BY "serieId", temporada, "numeroEp"
    HAVING COUNT(*) > 1
  `;

  console.log(`📊 ${dupes.length} combinações (serieId, temp, ep) com duplicatas\n`);
  if (dupes.length === 0) { console.log("Nada a fazer!"); return; }

  let deletados = 0;
  let erros = 0;
  const BATCH = 200;

  for (let i = 0; i < dupes.length; i += BATCH) {
    const batch = dupes.slice(i, i + BATCH);

    for (const { serieId, temporada, numeroEp } of batch) {
      const eps = await prisma.episodio.findMany({
        where: { serieId, temporada, numeroEp },
        orderBy: { createdAt: "asc" },
      });
      if (eps.length < 2) continue;

      // Ordena por score desc — primeiro = vencedor
      eps.sort((a, b) => score(b) - score(a));
      const [vencedor, ...perdedores] = eps;

      for (const p of perdedores) {
        if (!DRY) {
          try {
            // Move histórico para o vencedor antes de apagar
            await prisma.watchHistory.updateMany({
              where: { episodioId: p.id },
              data: { episodioId: vencedor.id },
            });
            await prisma.episodio.delete({ where: { id: p.id } });
            deletados++;
          } catch (e: any) {
            erros++;
            console.error(`  ⚠️  Erro ao apagar ${p.id}:`, e.message);
          }
        } else {
          deletados++;
        }
      }
    }

    if (!DRY) process.stdout.write(`\r  Progresso: ${Math.min(i + BATCH, dupes.length)}/${dupes.length}`);
  }

  console.log(`\n\n🎉 ${deletados} episódios ${DRY ? "para apagar" : "apagados"} | ${erros} erros`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); });
