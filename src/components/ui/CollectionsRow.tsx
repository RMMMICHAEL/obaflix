import { getCollection } from "@/lib/tmdb";
import { CollectionRail, type CollectionRailItem } from "./CollectionRail";

const FILM_COLLECTIONS = [
  { id: 10,    nome: "Star Wars" },
  { id: 1241,  nome: "Harry Potter" },
  { id: 9485,  nome: "Velozes e Furiosos" },
  { id: 86311, nome: "Os Vingadores" },
  { id: 8650,   nome: "Transformers" },
  { id: 120794, nome: "Batman" },
  { id: 87359,  nome: "Missão: Impossível" },
  { id: 645,    nome: "James Bond" },
  { id: 295,    nome: "Piratas do Caribe" },
  { id: 119,    nome: "O Senhor dos Anéis" },
  { id: 121938, nome: "O Hobbit" },
  { id: 2344,   nome: "Matrix" },
  { id: 556,    nome: "Homem-Aranha" },
  { id: 131296, nome: "Thor" },
  { id: 131292, nome: "Homem de Ferro" },
  { id: 173710, nome: "Planeta dos Macacos" },
  { id: 8091,   nome: "Alien" },
  { id: 399,    nome: "Predador" },
];

const ANIMATION_COLLECTIONS = [
  { id: 2150,   nome: "Shrek" },
  { id: 10194,  nome: "Toy Story" },
  { id: 87118,  nome: "Carros" },
  { id: 468222, nome: "Os Incríveis" },
  { id: 137697, nome: "Procurando Nemo" },
  { id: 137696, nome: "Monstros S.A." },
  { id: 14740,  nome: "Madagascar" },
  { id: 77816,  nome: "Kung Fu Panda" },
  { id: 89137,  nome: "Como Treinar o Seu Dragão" },
  { id: 86066,  nome: "Meu Malvado Favorito" },
  { id: 8354,   nome: "A Era do Gelo" },
  { id: 185103, nome: "Hotel Transilvânia" },
  { id: 386382, nome: "Frozen" },
];

async function CollectionSection({
  collections,
  title,
}: {
  collections: typeof FILM_COLLECTIONS;
  title: string;
}) {
  const results = await Promise.all(
    collections.map(async (c) => {
      const data = await getCollection(c.id);
      if (!data) return null;
      return {
        id: c.id,
        nome: data.name || c.nome,
        poster: data.poster_path ?? null,
        backdrop: data.backdrop_path ?? null,
        count: data.parts?.length ?? 0,
      } as CollectionRailItem;
    })
  );

  const cards = results.filter((r): r is CollectionRailItem => r !== null && (r.poster !== null || r.backdrop !== null));
  if (cards.length === 0) return null;

  return (
    <section className="relative px-6 md:px-12 py-3 group/row">
      <h2 className="text-lg md:text-xl font-bold mb-3 flex items-center gap-3">
        {title}
      </h2>

      <CollectionRail cards={cards} />
    </section>
  );
}

export function CollectionsRow() {
  return <CollectionSection collections={FILM_COLLECTIONS} title="Coleções" />;
}

export function AnimationCollectionsRow() {
  return <CollectionSection collections={ANIMATION_COLLECTIONS} title="Coleções de animação" />;
}
