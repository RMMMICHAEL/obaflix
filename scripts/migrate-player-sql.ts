import { prisma } from "../src/lib/prisma";

async function run(sql: string) {
  return prisma.$executeRawUnsafe(sql);
}

async function main() {
  const [r1, r2, r3, r4, r5, r6, r7, r8] = await Promise.all([
    run(`UPDATE "Filme" SET "urlDub" = regexp_replace("urlDub", 'https?://hgbazooka\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlDub" LIKE '%hgbazooka.com%'`),
    run(`UPDATE "Filme" SET "urlLeg" = regexp_replace("urlLeg", 'https?://hgbazooka\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlLeg" LIKE '%hgbazooka.com%'`),
    run(`UPDATE "Filme" SET "urlDub" = regexp_replace("urlDub", 'https?://hailindihg\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlDub" LIKE '%hailindihg.com%'`),
    run(`UPDATE "Filme" SET "urlLeg" = regexp_replace("urlLeg", 'https?://hailindihg\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlLeg" LIKE '%hailindihg.com%'`),
    run(`UPDATE "Episodio" SET "urlDub" = regexp_replace("urlDub", 'https?://hgbazooka\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlDub" LIKE '%hgbazooka.com%'`),
    run(`UPDATE "Episodio" SET "urlLeg" = regexp_replace("urlLeg", 'https?://hgbazooka\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlLeg" LIKE '%hgbazooka.com%'`),
    run(`UPDATE "Episodio" SET "urlDub" = regexp_replace("urlDub", 'https?://hailindihg\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlDub" LIKE '%hailindihg.com%'`),
    run(`UPDATE "Episodio" SET "urlLeg" = regexp_replace("urlLeg", 'https?://hailindihg\\.com/([^,\\s]+)', 'https://vibuxer.com/e/\\1', 'g') WHERE "urlLeg" LIKE '%hailindihg.com%'`),
  ]);

  const filmes = r1 + r2 + r3 + r4;
  const episodios = r5 + r6 + r7 + r8;

  console.log(`Filmes atualizados:    ${filmes}`);
  console.log(`Episódios atualizados: ${episodios}`);
  console.log("✅ Concluído!");

  await prisma.$disconnect();
}

main().catch(console.error);
