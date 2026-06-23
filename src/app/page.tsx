import { HeroSlider } from "@/components/ui/HeroSlider";
import { ContentRow } from "@/components/ui/ContentRow";
import { prisma } from "@/lib/prisma";

async function getHomeData() {
  try {
    const [lancamentosFilmes, lancamentosSeries, destaquesFilmes, destaquesSeries, animes, desenhos] =
      await Promise.all([
        prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
        prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
        prisma.filme.findMany({ orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
        prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
        prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
        prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      ]);

    const hero = [...lancamentosFilmes.slice(0, 3), ...lancamentosSeries.slice(0, 2)];

    return { hero, lancamentosFilmes, lancamentosSeries, destaquesFilmes, destaquesSeries, animes, desenhos };
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const data = await getHomeData();

  if (!data || data.lancamentosFilmes.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-5xl font-black text-red-600 mb-3">STREAMIX</h1>
          <p className="text-zinc-400">Configure o banco de dados e importe o catálogo para começar.</p>
        </div>
      </div>
    );
  }

  const toCard = (item: any, defaultTipo: string) => ({
    id: item.id,
    tipo: (item.tipo ?? defaultTipo) as any,
    titulo: item.titulo,
    poster: item.poster,
    ano: item.ano,
    nota: item.nota,
    urlDub: item.urlDub,
    urlLeg: item.urlLeg,
  });

  return (
    <div className="pb-16">
      <HeroSlider items={data.hero.map((i: any) => ({ ...i, tipo: i.tipo ?? "filme" }))} />
      <div className="mt-6">
        <ContentRow titulo="Lançamentos — Filmes" items={data.lancamentosFilmes.map((i: any) => toCard(i, "filme"))} />
        <ContentRow titulo="Lançamentos — Séries" items={data.lancamentosSeries.map((i: any) => toCard(i, "serie"))} />
        <ContentRow titulo="Melhores Filmes" items={data.destaquesFilmes.map((i: any) => toCard(i, "filme"))} />
        <ContentRow titulo="Melhores Séries" items={data.destaquesSeries.map((i: any) => toCard(i, "serie"))} />
        <ContentRow titulo="Animes" items={data.animes.map((i: any) => toCard(i, "anime"))} />
        <ContentRow titulo="Desenhos" items={data.desenhos.map((i: any) => toCard(i, "desenho"))} />
      </div>
    </div>
  );
}
