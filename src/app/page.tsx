import { HeroSlider } from "@/components/ui/HeroSlider";
import { ContentRow } from "@/components/ui/ContentRow";

async function getHomeData() {
  try {
    const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const res = await fetch(`${base}/api/home`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const data = await getHomeData();

  if (!data) {
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
