import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getCollection, imgUrl } from "@/lib/tmdb";

const COLECOES = [
  { id: 10,    nome: "Star Wars" },
  { id: 1241,  nome: "Harry Potter" },
  { id: 9485,  nome: "Velozes e Furiosos" },
  { id: 86311, nome: "Os Vingadores" },
  { id: 131296, nome: "Transformers" },
  { id: 33671,  nome: "Batman" },
  { id: 87097,  nome: "Missão: Impossível" },
  { id: 8650,   nome: "James Bond" },
  { id: 2150,   nome: "Piratas do Caribe" },
  { id: 119,    nome: "O Senhor dos Anéis" },
  { id: 295130, nome: "O Hobbit" },
  { id: 748,    nome: "Matrix" },
  { id: 422837, nome: "Homem-Aranha" },
  { id: 131292, nome: "Thor" },
  { id: 531241, nome: "Homem de Ferro" },
  { id: 86055,  nome: "Planeta dos Macacos" },
  { id: 656,    nome: "Alien" },
  { id: 2806,   nome: "Predador" },
  { id: 230,    nome: "Shrek" },
  { id: 2980,   nome: "Toy Story" },
];

interface CollectionCard {
  id: number;
  nome: string;
  poster: string | null;
  backdrop: string | null;
  count: number;
}

export async function CollectionsRow() {
  const results = await Promise.all(
    COLECOES.map(async (c) => {
      const data = await getCollection(c.id);
      if (!data) return null;
      return {
        id: c.id,
        nome: data.name || c.nome,
        poster: data.poster_path ?? null,
        backdrop: data.backdrop_path ?? null,
        count: data.parts?.length ?? 0,
      } as CollectionCard;
    })
  );

  const cards = results.filter((r): r is CollectionCard => r !== null && (r.poster !== null || r.backdrop !== null));
  if (cards.length === 0) return null;

  return (
    <section className="relative px-6 md:px-12 py-3 group/row">
      <h2 className="text-lg md:text-xl font-bold mb-3 flex items-center gap-3">
        Coleções
      </h2>

      <div className="relative -mx-6 md:-mx-12">
        <button className="absolute right-0 top-0 bottom-0 z-20 w-12 md:w-16 flex items-center justify-center bg-gradient-to-l from-black to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity">
          <ChevronRight className="w-7 h-7" />
        </button>

        <div className="flex gap-3 overflow-x-auto scrollbar-hide px-6 md:px-12 scroll-smooth">
          {cards.map((card) => (
            <Link
              key={card.id}
              href={`/colecao/${card.id}`}
              className="group/card relative shrink-0 w-[140px] sm:w-[160px] md:w-[200px]"
            >
              <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-zinc-900">
                {(card.poster || card.backdrop) && (
                  <Image
                    src={imgUrl(card.poster ?? card.backdrop, "w342")}
                    alt={card.nome}
                    fill
                    className="object-cover transition-transform duration-300 group-hover/card:scale-105"
                    sizes="(max-width: 640px) 140px, (max-width: 768px) 160px, 200px"
                    loading="lazy"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent opacity-0 group-hover/card:opacity-100 transition-opacity duration-200" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
              </div>
              <p className="mt-2 text-sm font-medium text-gray-200 truncate group-hover/card:text-white transition-colors duration-200">
                {card.nome}
              </p>
              {card.count > 0 && (
                <p className="text-[11px] text-zinc-500 mt-0.5">{card.count} filmes</p>
              )}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
