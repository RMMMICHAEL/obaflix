/**
 * Detecta e remove séries/filmes duplicados no obaflix.
 * Critério: mesmo título (case-insensitive) → mantém o que tem mais episódios
 * ou, em empate, o ID numérico maior (mais recente no Megaflix).
 *
 * Uso:
 *   npx tsx scripts/cleanup-dupes.ts --dry-run   (só lista, não apaga)
 *   npx tsx scripts/cleanup-dupes.ts              (apaga duplicatas)
 */

const OBA   = process.env.OBAFLIX_URL ?? "https://obaflix.vercel.app";
const TOKEN = process.env.ADMIN_SECRET_TOKEN ?? "@Oba152535";
const DRY   = process.argv.includes("--dry-run");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchAllSeries() {
  const all: any[] = [];
  let page = 1;
  process.stdout.write("🔍 Carregando séries");
  while (true) {
    const r = await fetch(`${OBA}/api/admin/serie?page=${page}`, { headers: { "x-admin-token": TOKEN } });
    const d = await r.json();
    if (!d.items?.length) break;
    all.push(...d.items);
    process.stdout.write(".");
    if (page >= d.pages) break;
    page++;
    await sleep(80);
  }
  console.log(` ${all.length} carregadas`);
  return all;
}

async function deleteSerie(id: string) {
  const r = await fetch(`${OBA}/api/admin/serie`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "x-admin-token": TOKEN },
    body: JSON.stringify({ id }),
  });
  return r.json().catch(() => ({}));
}

function scoreId(id: string): number {
  // IDs puramente numéricos e maiores = mais recentes no Megaflix
  const n = Number(id.replace(/\D/g, ""));
  return isNaN(n) ? 0 : n;
}

async function main() {
  console.log(`\n🧹 Cleanup de duplicatas — modo: ${DRY ? "DRY RUN (só lista)" : "REAL (vai apagar)"}\n`);

  const series = await fetchAllSeries();

  // Agrupa por título normalizado
  const byTitle = new Map<string, any[]>();
  for (const s of series) {
    const key = s.titulo.toLowerCase().trim();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(s);
  }

  const dupes = [...byTitle.entries()]
    .filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length); // mais duplicatas primeiro

  console.log(`\n📊 Títulos duplicados: ${dupes.length}\n`);

  let deletados = 0;
  let epsApagados = 0;

  for (const [titulo, items] of dupes) {
    // Escolhe o "vencedor": mais eps; em empate, ID maior (mais recente)
    const vencedor = items.reduce((best, cur) => {
      const bestEps = best._count?.episodios ?? 0;
      const curEps  = cur._count?.episodios ?? 0;
      if (curEps > bestEps) return cur;
      if (curEps === bestEps && scoreId(cur.id) > scoreId(best.id)) return cur;
      return best;
    });

    const perdedores = items.filter(x => x.id !== vencedor.id);

    console.log(`📺 "${titulo}"`);
    console.log(`   ✔ Manter: ${vencedor.id} (${vencedor._count?.episodios} eps)`);
    perdedores.forEach(p => console.log(`   ✖ Apagar: ${p.id} (${p._count?.episodios} eps)`));

    if (!DRY) {
      for (const p of perdedores) {
        await sleep(200);
        const r = await deleteSerie(p.id);
        if (r.ok) {
          deletados++;
          epsApagados += p._count?.episodios ?? 0;
        } else {
          console.log(`   ⚠️  Erro ao apagar ${p.id}:`, r);
        }
      }
    }
  }

  console.log(`\n🎉 Concluído!`);
  if (DRY) {
    console.log(`   ${dupes.length} títulos duplicados detectados.`);
    console.log(`   Rode sem --dry-run para apagar as duplicatas.`);
  } else {
    console.log(`   ${deletados} séries apagadas | ${epsApagados} episódios removidos`);
  }
}

main().catch(console.error);
