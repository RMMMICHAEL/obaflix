"use client";

import { useEffect, useState } from "react";
import { PeopleRow, type PeopleRowItem } from "@/components/ui/PeopleRow";

interface Pessoas {
  criacaoDirecao: PeopleRowItem[];
  elenco: PeopleRowItem[];
}

/**
 * Elenco e criação/direção buscados pelo navegador, depois da ficha utilizável.
 * Como o fetch roda no cliente, este trabalho NÃO participa da geração ISR de
 * /serie/[id] — o hero e os episódios não esperam por ele. 503 (falha
 * transitória) entra no catch e some silenciosamente; um refresh tenta de novo.
 */
export function SerieCreditosClient({ serieId }: { serieId: string }) {
  const [data, setData] = useState<Pessoas | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/series/${serieId}/creditos`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error("creditos");
        return r.json();
      })
      .then((d: Pessoas) => setData(d))
      .catch(() => {});
    return () => ac.abort();
  }, [serieId]);

  if (!data) return null;

  return (
    <>
      <PeopleRow title="Criação e direção" people={data.criacaoDirecao ?? []} />
      <PeopleRow title="Elenco principal" people={data.elenco ?? []} />
    </>
  );
}
