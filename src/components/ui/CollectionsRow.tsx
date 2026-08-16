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

// Metadados estáveis das coleções de animação. Mantê-los locais evita 13
// chamadas ao TMDB durante a abertura da página infantil.
const ANIMATION_COLLECTION_CARDS: CollectionRailItem[] = [
  { id: 2150, nome: "Shrek: Coleção", poster: "/FlCOvuibrkww69JUcXLy3pOCBw.jpg", backdrop: "/lhsd1zCsq5UquvcNalmhuddV3tI.jpg", count: 5 },
  { id: 10194, nome: "Toy Story: Coleção", poster: "/vgloOQGIDJJkIq1nTv9y3n2TokC.jpg", backdrop: "/hApclyB9NEZEQujAVajzi5iWE4a.jpg", count: 5 },
  { id: 87118, nome: "Carros: Coleção", poster: "/3xgI2de9NV3HdvVKq2HBjS7uQRx.jpg", backdrop: "/A8DqaTGwZ8iCEjWMNRsZumzfKLw.jpg", count: 3 },
  { id: 468222, nome: "Os Incríveis: Coleção", poster: "/l7GqbzkJwowYRIXAtUz2iCPi64a.jpg", backdrop: "/6oi6V1O9MJRNnfV8E9JMntmFqBD.jpg", count: 3 },
  { id: 137697, nome: "Procurando Nemo: Coleção", poster: "/cCovtlN16ykvyFYnzKyv3dFtceG.jpg", backdrop: "/yzqaKAhglTrkeOfuIXYYArf0WnA.jpg", count: 2 },
  { id: 137696, nome: "Monstros S.A.: Coleção", poster: "/vdCXiJl9jJlwa0YlOL8qHjL0hy6.jpg", backdrop: "/x4Mq7gDRhbqDjw4SkemLvd1yzF3.jpg", count: 2 },
  { id: 14740, nome: "Madagascar: Coleção", poster: "/jehSFsO0ViCSrGmQeRXo9mjenVp.jpg", backdrop: "/lzTIAbvMeGWB7PUrmBZXulGA28M.jpg", count: 3 },
  { id: 77816, nome: "Kung Fu Panda: Coleção", poster: "/2niOAGSPxhdcRfbcXGDg4doNp9z.jpg", backdrop: "/2nbtv33hEk2CTnuMhTGZgsFdi3K.jpg", count: 4 },
  { id: 89137, nome: "Como Treinar o Seu Dragão: Coleção", poster: "/cUBgJx9G4CdKhOlj7R7kWbEQMAY.jpg", backdrop: "/mvcfPkOvgDJG2lEAxTz0NKqoQLo.jpg", count: 3 },
  { id: 86066, nome: "Meu Malvado Favorito: Coleção", poster: "/vCXbRZwV09KChsc0MoQbMUHkRK1.jpg", backdrop: "/37xamYKRUGCRux532lKcZdVGYuR.jpg", count: 4 },
  { id: 8354, nome: "A Era do Gelo: Coleção", poster: "/f5PM3zXVhd8O1YnPqbkI3gHsWe4.jpg", backdrop: "/ovWkSikbJUMwwmUdD6WTa1bbFrh.jpg", count: 7 },
  { id: 185103, nome: "Hotel Transilvânia: Coleção", poster: "/hmBT5J6rWZaYA8qbbZkcSJnivHe.jpg", backdrop: "/5MJt6g7k9gADQH4xHn5mOEMa3Vr.jpg", count: 5 },
  { id: 386382, nome: "Frozen: Coleção", poster: "/xibZTW6FdC9Nd8sJQks95rYa6JV.jpg", backdrop: "/s3vdRkK7KZFUDC8HEJo2GRKyVhW.jpg", count: 4 },
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
  return (
    <section className="relative px-6 py-3 md:px-12">
      <h2 className="mb-3 text-lg font-bold md:text-xl">Coleções de animação</h2>
      <CollectionRail cards={ANIMATION_COLLECTION_CARDS} />
    </section>
  );
}
