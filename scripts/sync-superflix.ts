import { syncSuperflixCalendar } from "../src/lib/superflix-calendar";
import { prisma } from "../src/lib/prisma";

async function main() {
  const backfillExisting = process.argv.includes("--backfill");
  console.log("Buscando atualizações no calendário da SuperFlix...");
  if (backfillExisting) console.log("Modo reparo: completando temporadas das séries SuperFlix existentes.");
  const result = await syncSuperflixCalendar(
    (message) => console.log(`[SuperFlix] ${message}`),
    { backfillExisting },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.erros.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
