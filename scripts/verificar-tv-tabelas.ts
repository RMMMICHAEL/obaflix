/**
 * Confere que a migracao do pareamento entrou como esperado — e apenas ela.
 *
 * Rodar com: npx tsx scripts/verificar-tv-tabelas.ts
 */
import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("TvDevice        linhas:", await prisma.tvDevice.count());
  console.log("TvRefreshToken  linhas:", await prisma.tvRefreshToken.count());

  const indices = await prisma.$queryRawUnsafe<{ tablename: string; indexname: string }[]>(
    `select tablename, indexname from pg_indexes
      where tablename in ('TvDevice','TvRefreshToken')
      order by tablename, indexname`,
  );
  for (const i of indices) console.log(`  ${i.tablename}.${i.indexname}`);

  // A divergencia antiga do schema nao pode ter entrado de carona.
  const episodio = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `select indexname from pg_indexes
      where tablename = 'Episodio' and indexname = 'Episodio_serieId_temporada_numeroEp_key'`,
  );
  console.log(
    "indice unico de Episodio:",
    episodio.length ? "PRESENTE (nao era para estar)" : "ausente — correto, nao foi tocado",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
