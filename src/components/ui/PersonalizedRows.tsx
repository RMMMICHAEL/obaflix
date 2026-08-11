"use client";

import { useEffect, useState } from "react";
import { ContentRow } from "@/components/ui/ContentRow";
import type { RecommendationRow } from "@/lib/recommendations";

export function PersonalizedRows() {
  const [rows, setRows] = useState<RecommendationRow[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/recommendations", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => setRows(data?.rows ?? []))
      .catch((error) => {
        if (error?.name !== "AbortError") setRows([]);
      });
    return () => controller.abort();
  }, []);

  if (rows === null) {
    return (
      <div className="mb-5 px-4 md:px-8" aria-label="Carregando recomendações">
        <div className="h-5 w-48 animate-pulse rounded bg-zinc-800" />
        <div className="mt-3 flex gap-3 overflow-hidden">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="aspect-[2/3] w-32 flex-none animate-pulse rounded-lg bg-zinc-900 md:w-40" />
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) return null;

  return (
    <div aria-label="Recomendações personalizadas">
      {rows.map((row) => <ContentRow key={row.id} titulo={row.titulo} items={row.items} />)}
    </div>
  );
}
