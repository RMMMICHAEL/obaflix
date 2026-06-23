import { prisma } from "../src/lib/prisma";

async function main() {
  const eps = await prisma.episodio.findMany({
    where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
    select: { urlDub: true, urlLeg: true },
  });
  const filmes = await prisma.filme.findMany({
    where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
    select: { urlDub: true, urlLeg: true },
  });

  const domains = new Map<string, number>();
  const extract = (val: string | null) => {
    if (!val) return;
    val.split(",").forEach((u) => {
      try {
        const d = new URL(u.trim()).hostname;
        domains.set(d, (domains.get(d) ?? 0) + 1);
      } catch {}
    });
  };

  [...eps, ...filmes].forEach((r) => { extract(r.urlDub); extract(r.urlLeg); });

  const sorted = [...domains.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nDomínios no banco:\n");
  sorted.forEach(([d, c]) => console.log(`  ${String(c).padStart(5)}x  ${d}`));
  console.log(`\nTotal: ${eps.length} episódios + ${filmes.length} filmes`);

  await prisma.$disconnect();
}

main().catch(console.error);
