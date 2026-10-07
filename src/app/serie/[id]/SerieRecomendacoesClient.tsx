"use client";

import { useEffect, useState } from "react";
import { LandscapeRow } from "@/components/ui/LandscapeRow";

/**
 * "Conteúdos parecidos".
 *
 * Nasce com `initialItems` — a baseline LOCAL por gênero renderizada no servidor
 * (ISR), então os LandscapeCard → Link já estão no HTML inicial (internal linking
 * de SEO). Depois da hidratação, busca o endpoint público para MELHORAR a seleção
 * com o TMDB; só substitui se vier uma lista válida e não vazia. Falha de
 * rede/TMDB nunca apaga as recomendações locais já exibidas.
 *
 * getTVRecommendations continua fora do ISR (roda no endpoint, não aqui nem na
 * página).
 */
export function SerieRecomendacoesClient({
  serieId,
  serieTitulo,
  initialItems = [],
}: {
  serieId: string;
  serieTitulo: string;
  initialItems?: any[];
}) {
  const [items, setItems] = useState<any[]>(initialItems);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/series/${serieId}/recomendacoes`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error("recomendacoes");
        return r.json();
      })
      .then((d: { items?: any[] }) => {
        // Só melhora: lista válida e não vazia substitui a baseline local.
        if (Array.isArray(d.items) && d.items.length) setItems(d.items);
      })
      .catch(() => {
        // Mantém a baseline local — nunca apaga por falha de rede/TMDB.
      });
    return () => ac.abort();
  }, [serieId]);

  if (!items.length) return null;

  return (
    <div className="pt-4">
      <LandscapeRow titulo={`Conteúdos parecidos com ${serieTitulo}`} items={items} />
    </div>
  );
}
