/**
 * Detecta e remove séries duplicadas por título (manutenção controlada).
 * Critério: mesmo título (case-insensitive) → mantém o que tem mais episódios
 * ou, em empate, o ID numérico maior (mais recente no Megaflix).
 *
 * Uso:
 *   npx tsx scripts/cleanup-dupes.ts             (DRY RUN — padrão, só lista)
 *   npx tsx scripts/cleanup-dupes.ts --apply     (apaga as duplicatas)
 *
 * Acesso direto ao banco (DATABASE_URL), como os demais scripts de
 * manutenção. NÃO usa HTTP nem token nenhum: remover série é destrutivo e
 * leva junto episódios, histórico e lista dos usuários, então não pode ficar
 * atrás do ADMIN_SECRET_TOKEN legado nem do CATALOG_SYNC_TOKEN (que só faz
 * upsert de catálogo). Até a versão anterior o padrão era apagar; agora é
 * listar, e apagar exige --apply explícito.
 *
 * Cada série removida sai numa transação, na mesma ordem do DELETE do painel
 * (/api/admin/serie): histórico, lista, gêneros, episódios, série.
 */
import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");

function scoreId(id: string): number {
  // IDs puramente numéricos e maiores = mais recentes no Megaflix
  const n = Number(id.replace(/\D/g, ""));
  return isNaN(n) ? 0 : n;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(`\n🧹 Cleanup de séries duplicadas — modo: ${APPLY ? "APPLY (vai apagar)" : "DRY RUN (só lista)"}\n`);

    const series = await prisma.serie.findMany({
      select: { id: true, titulo: true, _count: { select: { episodios: true } } },
      orderBy: { id: "asc" },
    });
    console.log(`🔍 ${series.length} séries carregadas`);

    const byTitle = new Map<string, typeof series>();
    for (const s of series) {
      const key = s.titulo.toLowerCase().trim();
      byTitle.set(key, [...(byTitle.get(key) ?? []), s]);
    }
    const dupes = [...byTitle.entries()]
      .filter(([, v]) => v.length > 1)
      .sort((a, b) => b[1].length - a[1].length);
    console.log(`\n📊 Títulos duplicados: ${dupes.length}\n`);

    let deletados = 0;
    let epsApagados = 0;
    let erros = 0;
    for (const [titulo, items] of dupes) {
      const vencedor = items.reduce((best, cur) => {
        if (cur._count.episodios > best._count.episodios) return cur;
        if (cur._count.episodios === best._count.episodios && scoreId(cur.id) > scoreId(best.id)) return cur;
        return best;
      });
      const perdedores = items.filter((x) => x.id !== vencedor.id);
      console.log(`📺 "${titulo}"`);
      console.log(`   ✔ Manter: ${vencedor.id} (${vencedor._count.episodios} eps)`);
      perdedores.forEach((p) => console.log(`   ✖ Apagar: ${p.id} (${p._count.episodios} eps)`));
      if (!APPLY) continue;

      for (const p of perdedores) {
        try {
          await prisma.$transaction([
            prisma.watchHistory.deleteMany({ where: { conteudoId: p.id } }),
            prisma.watchlist.deleteMany({ where: { conteudoId: p.id } }),
            prisma.serieGenero.deleteMany({ where: { serieId: p.id } }),
            prisma.episodio.deleteMany({ where: { serieId: p.id } }),
            prisma.serie.delete({ where: { id: p.id } }),
          ]);
          deletados++;
          epsApagados += p._count.episodios;
        } catch (error) {
          erros++;
          console.log(`   ⚠️  Erro ao apagar ${p.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    console.log(`\n🎉 Concluído!`);
    if (!APPLY) {
      console.log(`   ${dupes.length} títulos duplicados detectados. Nada foi alterado.`);
      console.log(`   Para apagar: npx tsx scripts/cleanup-dupes.ts --apply (faça backup antes).`);
    } else {
      console.log(`   ${deletados} séries apagadas | ${epsApagados} episódios removidos | ${erros} erros`);
      if (erros > 0) process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
