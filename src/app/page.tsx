import { HeroSlider } from "@/components/ui/HeroSlider";
import { ContentRow } from "@/components/ui/ContentRow";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const GENEROS_DESTAQUE = [
  { id: 28,    nome: "Ação" },
  { id: 35,    nome: "Comédia" },
  { id: 27,    nome: "Terror" },
  { id: 10749, nome: "Romance" },
  { id: 878,   nome: "Ficção Científica" },
  { id: 18,    nome: "Drama" },
  { id: 12,    nome: "Aventura" },
  { id: 53,    nome: "Thriller" },
];

async function getHomeData() {
  try {
    const [
      lancamentosFilmes,
      lancamentosSeries,
      destaquesFilmes,
      destaquesSeries,
      animes,
      desenhos,
      ...generoFilmes
    ] = await Promise.all([
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 20, select: selFilme() }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 20, select: selSerie() }),
      prisma.filme.findMany({ where: { nota: { gt: 7 } }, orderBy: { nota: "desc" }, take: 20, select: selFilme() }),
      prisma.serie.findMany({ where: { tipo: "serie", nota: { gt: 7 } }, orderBy: { nota: "desc" }, take: 20, select: selSerie() }),
      prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { nota: "desc" }, take: 20, select: selSerie() }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 20, select: selSerie() }),
      ...GENEROS_DESTAQUE.map((g) =>
        prisma.filme.findMany({
          where: { generos: { some: { generoId: g.id } } },
          orderBy: { nota: "desc" },
          take: 20,
          select: selFilme(),
        })
      ),
    ]);

    const hero = [
      ...destaquesFilmes.slice(0, 3),
      ...destaquesSeries.slice(0, 2),
    ];

    return {
      hero,
      lancamentosFilmes,
      lancamentosSeries,
      destaquesFilmes,
      destaquesSeries,
      animes,
      desenhos,
      generoFilmes: GENEROS_DESTAQUE.map((g, i) => ({ ...g, filmes: generoFilmes[i] })),
    };
  } catch (e) {
    console.error("Home error:", e);
    return null;
  }
}

function selFilme() {
  return {
    id: true, titulo: true, poster: true, background: true,
    ano: true, nota: true, sinopse: true, urlDub: true, urlLeg: true,
  } as const;
}

function selSerie() {
  return {
    id: true, titulo: true, poster: true, background: true,
    ano: true, nota: true, sinopse: true, tipo: true,
  } as const;
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
    urlDub: item.urlDub ?? null,
    urlLeg: item.urlLeg ?? null,
  });

  return (
    <div className="pb-16">
      <HeroSlider items={data.hero.map((i: any) => ({ ...i, tipo: i.tipo ?? "filme" }))} />

      <div className="mt-6">
        <ContentRow titulo="🎬 Lançamentos — Filmes"  items={data.lancamentosFilmes.map((i) => toCard(i, "filme"))} />
        <ContentRow titulo="📺 Lançamentos — Séries"  items={data.lancamentosSeries.map((i) => toCard(i, "serie"))} />
        <ContentRow titulo="⭐ Melhores Filmes"        items={data.destaquesFilmes.map((i) => toCard(i, "filme"))} />
        <ContentRow titulo="⭐ Melhores Séries"        items={data.destaquesSeries.map((i) => toCard(i, "serie"))} />
        {data.animes.length > 0 && (
          <ContentRow titulo="🎌 Animes"               items={data.animes.map((i) => toCard(i, "anime"))} />
        )}
        {data.desenhos.length > 0 && (
          <ContentRow titulo="🖼️ Desenhos"             items={data.desenhos.map((i) => toCard(i, "desenho"))} />
        )}

        {data.generoFilmes.map((g) =>
          g.filmes.length > 0 ? (
            <ContentRow
              key={g.id}
              titulo={g.nome}
              items={g.filmes.map((i) => toCard(i, "filme"))}
            />
          ) : null
        )}
      </div>
    </div>
  );
}
