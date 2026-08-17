// Diagnóstico pontual: por que Teen Wolf não retorna nenhum player.
// Uso: node -r dotenv/config scripts/diag-teenwolf.js
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const series = await p.serie.findMany({
    where: { titulo: { contains: "Teen Wolf", mode: "insensitive" } },
    select: { id: true, titulo: true, tmdbId: true, tipo: true },
  });
  console.log("séries:", JSON.stringify(series, null, 1));

  for (const s of series) {
    const total = await p.episodio.count({ where: { serieId: s.id } });
    const comUrl = await p.episodio.count({
      where: { serieId: s.id, OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
    });
    console.log(`\n${s.id} "${s.titulo}" tmdb=${s.tmdbId} -> episódios=${total} com URL=${comUrl}`);
    const eps = await p.episodio.findMany({
      where: { serieId: s.id },
      take: 3,
      orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
      select: { temporada: true, numeroEp: true, urlDub: true, urlLeg: true },
    });
    console.log(JSON.stringify(eps, null, 1));
  }
  await p.$disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
