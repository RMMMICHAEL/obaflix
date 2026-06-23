import { prisma } from "../src/lib/prisma";

async function main() {
  const a = await prisma.episodio.findFirst({
    where: { OR: [{ urlDub: { contains: "hgbazooka" } }, { urlLeg: { contains: "hgbazooka" } }] },
    select: { urlDub: true, urlLeg: true },
  });
  const b = await prisma.episodio.findFirst({
    where: { OR: [{ urlDub: { contains: "hailindihg" } }, { urlLeg: { contains: "hailindihg" } }] },
    select: { urlDub: true, urlLeg: true },
  });

  const getUrl = (r: any, domain: string) => {
    const all = [r?.urlDub, r?.urlLeg].flatMap(v => v?.split(",") ?? []);
    return all.find(u => u.includes(domain))?.trim();
  };

  console.log("hgbazooka:", getUrl(a, "hgbazooka"));
  console.log("hailindihg:", getUrl(b, "hailindihg"));

  await prisma.$disconnect();
}

main().catch(console.error);
