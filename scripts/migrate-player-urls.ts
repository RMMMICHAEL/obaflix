/**
 * Migra URLs de players antigos → vibuxer.com/e/
 * Suporta múltiplas URLs separadas por vírgula
 *
 * Uso: npx tsx scripts/migrate-player-urls.ts
 * Dry-run: npx tsx scripts/migrate-player-urls.ts --dry
 */

import { prisma } from "../src/lib/prisma";

const OLD_BASES = ["hgbazooka.com", "hailindihg.com"];
const NEW_BASE = "https://vibuxer.com/e/";
const DRY = process.argv.includes("--dry");

function needsMigration(url: string): boolean {
  return OLD_BASES.some((b) => url.includes(b));
}

function migrateUrl(url: string): string {
  try {
    const u = new URL(url);
    const id = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (!id) return url;
    return `${NEW_BASE}${id}`;
  } catch {
    return url;
  }
}

function migrateField(value: string | null): { novo: string | null; mudou: boolean } {
  if (!value) return { novo: value, mudou: false };

  const parts = value.split(",").map((s) => s.trim());
  let mudou = false;

  const novos = parts.map((u) => {
    if (needsMigration(u)) {
      const novo = migrateUrl(u);
      if (novo !== u) { mudou = true; return novo; }
    }
    return u;
  });

  return { novo: novos.join(","), mudou };
}

async function main() {
  console.log(`\nModo: ${DRY ? "DRY-RUN (sem salvar)" : "REAL (vai salvar)"}`);
  console.log(`De: ${OLD_BASES.join(", ")}`);
  console.log(`Para: ${NEW_BASE}<id>\n`);

  let totalFilmes = 0;
  let totalEpisodios = 0;

  // ── Filmes ──────────────────────────────────────────────────────────────────
  const filmeWhere = {
    OR: OLD_BASES.flatMap((b) => [
      { urlDub: { contains: b } },
      { urlLeg: { contains: b } },
    ]),
  };

  const filmes = await prisma.filme.findMany({
    where: filmeWhere,
    select: { id: true, titulo: true, urlDub: true, urlLeg: true },
  });

  console.log(`Filmes encontrados: ${filmes.length}`);

  for (const f of filmes) {
    const dub = migrateField(f.urlDub);
    const leg = migrateField(f.urlLeg);
    if (!dub.mudou && !leg.mudou) continue;

    console.log(`\n  Filme: ${f.titulo} (${f.id})`);
    if (dub.mudou) { console.log(`    urlDub: ${f.urlDub}`); console.log(`         → ${dub.novo}`); }
    if (leg.mudou) { console.log(`    urlLeg: ${f.urlLeg}`); console.log(`         → ${leg.novo}`); }

    if (!DRY) {
      await prisma.filme.update({
        where: { id: f.id },
        data: {
          ...(dub.mudou ? { urlDub: dub.novo } : {}),
          ...(leg.mudou ? { urlLeg: leg.novo } : {}),
        },
      });
    }
    totalFilmes++;
  }

  // ── Episódios ────────────────────────────────────────────────────────────────
  const epWhere = {
    OR: OLD_BASES.flatMap((b) => [
      { urlDub: { contains: b } },
      { urlLeg: { contains: b } },
    ]),
  };

  const episodios = await prisma.episodio.findMany({
    where: epWhere,
    select: { id: true, serieId: true, temporada: true, numeroEp: true, urlDub: true, urlLeg: true },
  });

  console.log(`\nEpisódios encontrados: ${episodios.length}`);

  for (const ep of episodios) {
    const dub = migrateField(ep.urlDub);
    const leg = migrateField(ep.urlLeg);
    if (!dub.mudou && !leg.mudou) continue;

    console.log(`\n  EP: ${ep.serieId} T${ep.temporada}E${ep.numeroEp}`);
    if (dub.mudou) { console.log(`    urlDub: ${ep.urlDub}`); console.log(`         → ${dub.novo}`); }
    if (leg.mudou) { console.log(`    urlLeg: ${ep.urlLeg}`); console.log(`         → ${leg.novo}`); }

    if (!DRY) {
      await prisma.episodio.update({
        where: { id: ep.id },
        data: {
          ...(dub.mudou ? { urlDub: dub.novo } : {}),
          ...(leg.mudou ? { urlLeg: leg.novo } : {}),
        },
      });
    }
    totalEpisodios++;
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Filmes atualizados:    ${totalFilmes}`);
  console.log(`Episódios atualizados: ${totalEpisodios}`);
  if (DRY) console.log("\n⚠️  Dry-run. Rode sem --dry para aplicar.");
  else console.log("\n✅ Concluído!");

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
