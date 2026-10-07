"use client";

import { useEffect, useState } from "react";
import { LandscapeRow } from "@/components/ui/LandscapeRow";

/**
 * "Conteúdos parecidos" buscados pelo navegador, depois da ficha utilizável —
 * fora da geração ISR, igual aos créditos. Sem itens (ou em falha), não renderiza
 * nada: o bloco fica abaixo da dobra, então não há layout shift relevante.
 */
export function SerieRecomendacoesClient({
  serieId,
  serieTitulo,
}: {
  serieId: string;
  serieTitulo: string;
}) {
  const [items, setItems] = useState<any[] | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/series/${serieId}/recomendacoes`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error("recomendacoes");
        return r.json();
      })
      .then((d: { items?: any[] }) => setItems(d.items ?? []))
      .catch(() => {});
    return () => ac.abort();
  }, [serieId]);

  if (!items || !items.length) return null;

  return (
    <div className="pt-4">
      <LandscapeRow titulo={`Conteúdos parecidos com ${serieTitulo}`} items={items} />
    </div>
  );
}
